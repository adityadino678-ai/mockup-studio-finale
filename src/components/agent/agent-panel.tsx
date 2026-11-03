"use client";

// ---------------------------------------------------------------------------
// The agent panel.
//
// ONE panel, two surfaces:
//
//   - Listing details: the full toolset. The agent reads the design image,
//     researches Etsy, writes the copy and saves it to the listing drafts.
//   - Printify Studio: image generation only. The agent's job there is to
//     make an image, so the tool set is empty and the model picker only
//     offers image-generation models.
//
// The panel is a slide-in sheet, not a page: it opens over the current page
// and never navigates. Its open state is remembered per page, so returning to
// a page brings the panel back the way it was.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AlertTriangle, Check, Loader2, Sparkles, X } from "lucide-react";
import { db, getSetting, setSetting } from "@/lib/db/schema";
import {
  addMessage,
  createConversation,
  loadFavorites,
  saveFavorites,
  touchConversation,
} from "@/lib/client/chat";
import {
  activeModel,
  loadIntegrations,
  type IntegrationConfig,
} from "@/lib/client/integrations";
import {
  favoriteKey,
  filterModels,
  imageProviders,
  providerList,
  type ModelInfo,
} from "@/lib/ai/providers";
import { cn } from "@/lib/utils";
import { Composer } from "@/components/agent/composer";
import { ModelPicker, type ProviderModels } from "@/components/agent/model-picker";
import { MessageItem } from "@/components/agent/message-item";
import {
  answerQuestion,
  runAgentTurn,
  toolsForSurface,
  type PendingQuestion,
} from "@/lib/client/agent-loop";
import {
  currentActiveListing,
  describeSurface,
  readSurfaceContext,
} from "@/lib/client/agent-context";
import { generateImage } from "@/lib/client/image-generation";
import type {
  AgentChecklistItem,
  ChatMessage,
  ImagePartData,
  MessagePart,
} from "@/types/domain";

export type AgentSurface = "listing" | "studio";

interface AgentPanelProps {
  surface: AgentSurface;
  onClose(): void;
}

interface StreamState {
  text: string;
  reasoning: string;
}

/** The provider's key for a model picker group. */
function groupKey(providerId: string, modelId: string): string {
  return favoriteKey(providerId, modelId);
}

/** Where a surface's model choice is remembered. */
function selectionKey(surface: AgentSurface): string {
  return `agent:model:${surface}`;
}

/**
 * The headers that point the request at this surface's model.
 *
 * The saved integration config is global, but each surface has its own model:
 * the Listing agent needs a vision model and the Studio agent an image one.
 * These headers override the global choice for this request only.
 */
function modelHeaders(
  config: IntegrationConfig,
  selection: { providerId: string; modelId: string },
): Record<string, string> {
  if (!selection.providerId) return {};
  const key = config.providers[selection.providerId]?.apiKey?.trim();
  return {
    "x-ai-provider": selection.providerId,
    ...(key ? { "x-ai-key": key } : {}),
    ...(selection.modelId ? { "x-ai-model": selection.modelId } : {}),
  };
}

export function AgentPanel({ surface, onClose }: AgentPanelProps) {
  const [config, setConfig] = React.useState<IntegrationConfig | null>(null);
  const [favorites, setFavorites] = React.useState<string[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [attachments, setAttachments] = React.useState<ImagePartData[]>([]);
  const [history, setHistory] = React.useState<string[]>([]);
  const [streaming, setStreaming] = React.useState<StreamState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [canContinue, setCanContinue] = React.useState(false);
  const [checklist, setChecklist] = React.useState<AgentChecklistItem[]>([]);
  const [question, setQuestion] = React.useState<PendingQuestion | null>(null);
  const [answerDraft, setAnswerDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [modelLists, setModelLists] = React.useState<Record<string, ModelInfo[]>>({});
  /** The provider/model this surface talks to. */
  const [selection, setSelection] = React.useState<{ providerId: string; modelId: string }>({
    providerId: "",
    modelId: "",
  });
  const abortRef = React.useRef<AbortController | null>(null);
  const busyRef = React.useRef(false);
  const endRef = React.useRef<HTMLDivElement>(null);

  // --- config ----------------------------------------------------------------
  React.useEffect(() => {
    void (async () => {
      const [loaded, favs] = await Promise.all([loadIntegrations(), loadFavorites()]);
      setConfig(loaded);
      setFavorites(favs);
    })();
  }, []);

  // --- the conversation for this surface --------------------------------------
  //
  // One conversation per surface, remembered in the settings table, so the
  // Listing agent and the Studio agent never share a history.
  React.useEffect(() => {
    void (async () => {
      const key = `agent:conversation:${surface}`;
      const stored = await db.settings.get(key);
      const existingId = stored?.value as string | undefined;
      if (existingId) {
        const conversation = await db.conversations.get(existingId);
        if (conversation) {
          setConversationId(conversation.id);
          return;
        }
      }
      const created = await createConversation("custom", "", "New agent chat");
      await db.settings.put({ key, value: created.id });
      setConversationId(created.id);
    })();
  }, [surface]);

  const messages = useLiveQuery(
    async () => {
      if (!conversationId) return [] as ChatMessage[];
      const rows = await db.messages
        .where("conversationId")
        .equals(conversationId)
        .sortBy("createdAt");
      return rows;
    },
    [conversationId],
    [] as ChatMessage[],
  );

  // Restore this surface's model choice.
  React.useEffect(() => {
    let live = true;
    void getSetting<{ providerId: string; modelId: string }>(selectionKey(surface), {
      providerId: "",
      modelId: "",
    }).then((saved) => {
      if (live) setSelection(saved);
    });
    return () => {
      live = false;
    };
  }, [surface]);

  // --- the model picker ------------------------------------------------------
  //
  // The Listing agent may only use VISION models: it has to look at the
  // design image. The Studio agent may only use IMAGE models. A text-only
  // model in the Listing picker would silently invent what the design shows.
  const groups = React.useMemo<ProviderModels[]>(() => {
    if (!config) return [];
    const providers = surface === "studio" ? imageProviders() : providerList();
    return providers.map((provider) => {
      const saved = config.providers[provider.id]?.apiKey?.trim() ?? "";
      const cached = modelLists[provider.id] ?? [];
      const models =
        surface === "studio"
          ? filterModels(provider.id, cached, "image")
          : filterModels(provider.id, cached, "vision");
      return { provider, models, hasKey: !!saved };
    });
  }, [config, modelLists, surface]);

  // Fetch the live model list for the providers the user has a key for.
  React.useEffect(() => {
    if (!config) return;
    let cancelled = false;
    void (async () => {
      for (const provider of surface === "studio" ? imageProviders() : providerList()) {
        if (cancelled) return;
        const key = config.providers[provider.id]?.apiKey?.trim();
        if (!key) continue;
        try {
          const res = await fetch("/api/integrations/models", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-ai-provider": provider.id,
              "x-ai-key": key,
            },
            body: JSON.stringify({
              provider: provider.id,
              kind: surface === "studio" ? "image" : "vision",
            }),
          });
          if (!res.ok) continue;
          const data = (await res.json()) as { models?: ModelInfo[] };
          if (cancelled) return;
          setModelLists((prev) => ({ ...prev, [provider.id]: data.models ?? [] }));
        } catch {
          /* the picker still works from the cached list */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, surface]);

  const activeProviderId = selection.providerId;
  const activeModelId = selection.modelId;

  /**
   * The model is chosen PER SURFACE.
   *
   * The Listing agent needs a vision model and the Studio agent an image
   * model, so they cannot share one global "active model": picking one would
   * silently break the other. Each surface remembers its own choice.
   */
  const selectModelForSurface = React.useCallback(
    async (providerId: string, modelId: string) => {
      const next = { providerId, modelId };
      setSelection(next);
      await setSetting(selectionKey(surface), next);
    },
    [surface],
  );

  const toggleFavorite = React.useCallback(
    async (providerId: string, modelId: string) => {
      const key = groupKey(providerId, modelId);
      const next = favorites.includes(key)
        ? favorites.filter((f) => f !== key)
        : [...favorites, key];
      setFavorites(next);
      await saveFavorites(next);
    },
    [favorites],
  );

  // --- the surface context ---------------------------------------------------
  const [surfaceText, setSurfaceText] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const listing = currentActiveListing();
      const context = await readSurfaceContext(surface, listing?.designName);
      if (cancelled) return;
      setSurfaceText(describeSurface(context));
    })();
    return () => {
      cancelled = true;
    };
  }, [surface, messages?.length]);

  // --- sending ---------------------------------------------------------------
  const send = React.useCallback(async () => {
    if (!config || !conversationId || busyRef.current) return;
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setDraft("");
    setAttachments([]);
    setError(null);
    setCanContinue(false);
    setChecklist([]);
    setQuestion(null);
    busyRef.current = true;
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const parts: MessagePart[] = [];
      if (text) parts.push({ type: "text", text });
      for (const image of attachments) parts.push({ type: "image", image });
      await addMessage(conversationId, "user", parts);
      if (text) setHistory((h) => [...h, text].slice(-50));

      if (surface === "studio") {
        await runImageTurn(conversationId, text, config, controller.signal);
        return;
      }

      const provider = selection.providerId || config.activeProvider;
      const model = selection.modelId || activeModel(config);
      await runAgentTurn({
        conversationId,
        provider,
        model,
        headers: modelHeaders(config, selection),
        toolNames: toolsForSurface("listing"),
        context: surfaceText,
        userText: text,
        attachments,
        signal: controller.signal,
        events: {
          onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
          onReasoning: (t) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + t } : s)),
          onChecklist: (items) => setChecklist(items),
          onQuestion: (q) => setQuestion(q),
          onError: (message) => {
            setError(message);
            setCanContinue(message.includes("budget") || message.includes("without new information"));
          },
        },
      });
      await touchConversation(conversationId, { provider, model });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setStreaming(null);
      busyRef.current = false;
      setBusy(false);
      abortRef.current = null;
    }
  }, [config, conversationId, draft, attachments, surface, surfaceText, selection]);

  /**
   * The Studio turn: one image, generated by the image model.
   *
   * It is deliberately NOT a chat turn. The Studio agent's whole job is to
   * make an image, so it calls the image endpoint and shows the result.
   */
  const runImageTurn = React.useCallback(
    async (id: string, prompt: string, cfg: IntegrationConfig, signal: AbortSignal) => {
      if (!prompt) return;
      const provider = selection.providerId || cfg.activeProvider;
      const model = selection.modelId || activeModel(cfg);
      try {
        const image = await generateImage(prompt, model, provider, signal);
        await addMessage(
          id,
          "assistant",
          [
            { type: "text", text: `Generated with ${model}.` },
            { type: "image", image: { name: "generated.png", mime: image.mime, dataUrl: image.dataUrl } },
          ],
          { provider, model },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Image generation failed.";
        setError(message);
        await addMessage(id, "assistant", [{ type: "text", text: `Image generation failed: ${message}` }], {
          provider,
          model,
        });
      }
    },
    [selection],
  );

  const answer = React.useCallback(
    async (value: string) => {
      if (!conversationId || !question || !value.trim()) return;
      const chosen = value.trim();
      setQuestion(null);
      setAnswerDraft("");
      await answerQuestion(conversationId, question, chosen);
      // Resume: the answer is in the history, so the loop continues from it.
      setDraft("");
      setError(null);
      busyRef.current = true;
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        if (!config) return;
        const provider = selection.providerId || config.activeProvider;
        const model = selection.modelId || activeModel(config);
        await runAgentTurn({
          conversationId,
          provider,
          model,
          headers: modelHeaders(config, selection),
          toolNames: toolsForSurface("listing"),
          context: surfaceText,
          userText: chosen,
          attachments: [],
          signal: controller.signal,
          events: {
            onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
            onReasoning: (t) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + t } : s)),
            onChecklist: (items) => setChecklist(items),
            onQuestion: (q) => setQuestion(q),
            onError: (message) => setError(message),
          },
        });
      } finally {
        setStreaming(null);
        busyRef.current = false;
        setBusy(false);
        abortRef.current = null;
      }
    },
    [config, conversationId, question, surfaceText, selection],
  );

  const continueTurn = React.useCallback(async () => {
    if (!conversationId || !config) return;
    setError(null);
    setCanContinue(false);
    busyRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runAgentTurn({
        conversationId,
        provider: selection.providerId || config.activeProvider,
        model: selection.modelId || activeModel(config),
        headers: modelHeaders(config, selection),
        toolNames: toolsForSurface("listing"),
        context: surfaceText,
        userText: "",
        attachments: [],
        signal: controller.signal,
        events: {
          onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
          onReasoning: (t) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + t } : s)),
          onChecklist: (items) => setChecklist(items),
          onQuestion: (q) => setQuestion(q),
          onError: (message) => setError(message),
        },
      });
    } finally {
      setStreaming(null);
      busyRef.current = false;
      setBusy(false);
      abortRef.current = null;
    }
  }, [config, conversationId, surfaceText, selection]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages?.length, streaming, checklist.length]);

  const attachFiles = React.useCallback(async (files: FileList | File[]) => {
    const next: ImagePartData[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the file"));
        reader.readAsDataURL(file);
      });
      next.push({ name: file.name, mime: file.type, dataUrl });
    }
    if (next.length) setAttachments((prev) => [...prev, ...next]);
  }, []);

  const header = (
    <ModelPicker
      activeProviderId={activeProviderId}
      activeModelId={activeModelId}
      groups={groups}
      favorites={favorites}
      disabled={busy}
      onSelect={(providerId, modelId) => void selectModelForSurface(providerId, modelId)}
      onToggleFavorite={(providerId, modelId) => void toggleFavorite(providerId, modelId)}
    />
  );

  const title = surface === "studio" ? "Studio agent" : "Listing agent";

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-pop"
      aria-label={title}
      data-agent-panel={surface}
    >
      <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sage-soft text-forest">
          <Sparkles className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
          <div className="truncate text-[10px] text-ink-subtle">
            {surface === "studio" ? "Image generation" : "Research, write and save listing copy"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the agent panel"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {checklist.length > 0 && (
        <div className="border-b border-border-subtle bg-surface-muted px-3 py-2">
          <Checklist items={checklist} />
        </div>
      )}

      <div className="scroll-thin flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-3">
          {(messages ?? []).map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
          {streaming && (
            <MessageItem
              message={{
                id: "streaming",
                conversationId: conversationId ?? "",
                role: "assistant",
                parts: [
                  ...(streaming.reasoning ? [{ type: "reasoning" as const, text: streaming.reasoning }] : []),
                  { type: "text" as const, text: streaming.text },
                ],
                createdAt: Date.now(),
              }}
              streaming
            />
          )}
          {question && (
            <QuestionCard
              question={question}
              value={answerDraft}
              onChange={setAnswerDraft}
              onAnswer={answer}
            />
          )}
          {error && (
            <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] leading-relaxed text-danger">
              {error}
              {canContinue && (
                <button
                  type="button"
                  onClick={() => void continueTurn()}
                  disabled={busy}
                  className="mt-2 block rounded-md bg-forest px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-forest-deep disabled:opacity-40"
                >
                  Continue
                </button>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        onStop={() => abortRef.current?.abort()}
        streaming={busy}
        canAttach={surface === "listing"}
        attachments={attachments}
        onAttachFiles={(files) => void attachFiles(files)}
        onRemoveAttachment={(index) => setAttachments((prev) => prev.filter((_, i) => i !== index))}
        history={history}
        header={header}
        error={null}
      />
    </aside>
  );
}

/** The live checklist. One item is active at a time; the rest are pending. */
function Checklist({ items }: { items: AgentChecklistItem[] }) {
  return (
    <ul className="space-y-1" data-agent-checklist>
      {items.map((item, index) => (
        <li key={index} className="flex items-center gap-2 text-[11px]">
          {item.status === "done" ? (
            <Check className="h-3 w-3 shrink-0 text-forest" />
          ) : item.status === "failed" ? (
            <AlertTriangle className="h-3 w-3 shrink-0 text-danger" />
          ) : item.status === "active" ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-forest" />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" />
          )}
          <span className={cn(item.status === "pending" ? "text-ink-subtle" : "text-ink")}>
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The inline question card.
 *
 * It PAUSES the turn: the agent is waiting for an answer, and the chips are
 * the answer. A free-text field is always offered, because the right answer is
 * often not one of the chips.
 */
function QuestionCard({
  question,
  value,
  onChange,
  onAnswer,
}: {
  question: PendingQuestion;
  value: string;
  onChange(value: string): void;
  onAnswer(value: string): void;
}) {
  return (
    <div
      className="rounded-lg border border-sage bg-sage-soft/50 p-3"
      data-agent-question
      role="group"
      aria-label="The agent is waiting for an answer"
    >
      <p className="mb-2 text-[12px] font-medium leading-relaxed text-ink">{question.question}</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {question.options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onAnswer(option)}
            className="rounded-full border border-border-strong bg-surface px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-forest hover:text-forest"
          >
            {option}
          </button>
        ))}
      </div>
      {question.allowCustom && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer(value);
          }}
          className="flex items-center gap-1.5"
        >
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Or type your own answer…"
            aria-label="Your answer"
            className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none placeholder:text-ink-subtle focus:border-forest"
          />
          <button
            type="submit"
            disabled={!value.trim()}
            className="h-7 rounded-md bg-forest px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-forest-deep disabled:opacity-40"
          >
            Answer
          </button>
        </form>
      )}
    </div>
  );
}
