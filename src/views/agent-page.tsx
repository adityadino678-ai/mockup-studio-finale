"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Settings as SettingsIcon } from "lucide-react";
import { db } from "@/lib/db/schema";
import {
  activeModel,
  activeProvider,
  authedFetch,
  EMPTY_INTEGRATIONS,
  loadCachedModels,
  loadIntegrations,
  saveCachedModels,
  saveIntegrations,
  selectModel,
  selectProvider,
  type IntegrationConfig,
} from "@/lib/client/integrations";
import {
  addMessage,
  createConversation,
  deleteConversation,
  loadFavorites,
  messageTokens,
  patchToolCall,
  renameConversation,
  saveFavorites,
  setConversationPinned,
  streamReply,
  suggestTitle,
  toApiMessages,
  touchConversation,
} from "@/lib/client/chat";
import { confirmBatchJob, executeTool } from "@/lib/client/tools";
import { AGENT_TOOL_NAMES, parseToolArguments } from "@/lib/ai/tools";
import {
  favoriteKey,
  modelCapabilities,
  providerList,
  type ModelInfo,
  type ReasoningEffort,
} from "@/lib/ai/providers";
import { SessionsRail } from "@/components/agent/sessions-rail";
import { Transcript } from "@/components/agent/transcript";
import { Composer, type SlashCommand } from "@/components/agent/composer";
import { ModelPicker, type ProviderModels } from "@/components/agent/model-picker";
import { EffortPill } from "@/components/agent/effort-pill";
import { StatusBar } from "@/components/agent/status-bar";
import type { ChatMessage, ImagePartData, MessagePart, ToolCallData } from "@/types/domain";

const MAX_TURN_STEPS = 4;

interface StreamState {
  text: string;
  reasoning: string;
}

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<ImagePartData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mime: file.type, dataUrl: String(reader.result) });
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

export function AgentPage() {
  const [config, setConfig] = React.useState<IntegrationConfig | null>(null);
  const [modelsByProvider, setModelsByProvider] = React.useState<Record<string, ModelInfo[]>>({});
  const [favorites, setFavorites] = React.useState<string[]>([]);
  const [aiReady, setAiReady] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [attachments, setAttachments] = React.useState<ImagePartData[]>([]);
  const [history, setHistory] = React.useState<string[]>([]);
  const [effort, setEffort] = React.useState<ReasoningEffort>("medium");
  const [streaming, setStreaming] = React.useState<StreamState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tokensPerSecond, setTokensPerSecond] = React.useState<number | undefined>();
  const abortRef = React.useRef<AbortController | null>(null);
  const busyRef = React.useRef(false);

  const conversations = useLiveQuery(
    () => db.conversations.orderBy("updatedAt").reverse().toArray(),
    [],
    [],
  );
  const messages = useLiveQuery(
    () => (activeId ? db.messages.where("conversationId").equals(activeId).sortBy("createdAt") : []),
    [activeId],
    [] as ChatMessage[],
  );

  React.useEffect(() => {
    void (async () => {
      const [c, fav, status] = await Promise.all([
        loadIntegrations(),
        loadFavorites(),
        authedFetch("/api/integrations/status")
          .then((r) => r.json())
          .catch(() => null),
      ]);
      setConfig(c);
      setFavorites(fav);
      setAiReady(!!status?.ai?.configured);
      const map: Record<string, ModelInfo[]> = {};
      for (const p of providerList()) {
        if (c.providers[p.id]?.apiKey.trim() || p.keyOptional) {
          const cache = await loadCachedModels(p.id);
          if (cache?.models?.length) map[p.id] = cache.models;
        }
      }
      setModelsByProvider(map);
    })();
  }, []);

  const cfg = config ?? EMPTY_INTEGRATIONS;

  const caps = React.useMemo(
    () => modelCapabilities(cfg.activeProvider, activeModel(cfg)),
    [cfg],
  );

  const groups: ProviderModels[] = React.useMemo(
    () =>
      providerList().map((provider) => ({
        provider,
        models: modelsByProvider[provider.id] ?? [],
        hasKey: !!config?.providers[provider.id]?.apiKey.trim() || !!provider.keyOptional,
      })),
    [modelsByProvider, config],
  );

  const activeInfo = modelsByProvider[cfg.activeProvider]?.find((m) => m.id === activeModel(cfg));

  const contextTokens = React.useMemo(() => {
    const base = messages.reduce((sum, m) => sum + messageTokens(m), 0);
    const live = streaming ? Math.ceil((streaming.text.length + streaming.reasoning.length) / 4) : 0;
    return base + live;
  }, [messages, streaming]);

  const persistConfig = React.useCallback(async (next: IntegrationConfig) => {
    setConfig(next);
    await saveIntegrations(next);
  }, []);

  const onSelectModel = React.useCallback(
    async (providerId: string, modelId: string) => {
      if (!config) return;
      await persistConfig(selectModel(selectProvider(config, providerId), modelId));
    },
    [config, persistConfig],
  );

  const onToggleFavorite = React.useCallback(
    async (providerId: string, modelId: string) => {
      const key = favoriteKey(providerId, modelId);
      const next = favorites.includes(key) ? favorites.filter((f) => f !== key) : [...favorites, key];
      setFavorites(next);
      await saveFavorites(next);
    },
    [favorites],
  );

  const onRefreshModels = React.useCallback(
    async (providerId: string) => {
      if (!config) return;
      const pc = config.providers[providerId];
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-ai-provider": providerId,
      };
      if (pc?.apiKey.trim()) headers["x-ai-key"] = pc.apiKey.trim();
      if (pc?.baseUrl?.trim()) headers["x-ai-base-url"] = pc.baseUrl.trim();
      try {
        const res = await fetch("/api/integrations/models", {
          method: "POST",
          headers,
          body: JSON.stringify({ provider: providerId }),
        });
        const data = await res.json();
        if (data?.ok && Array.isArray(data.models)) {
          setModelsByProvider((m) => ({ ...m, [providerId]: data.models }));
          await saveCachedModels(providerId, data.models);
        }
      } catch {
        /* leave the cached list in place */
      }
    },
    [config],
  );

  const newChat = React.useCallback(() => {
    abortRef.current?.abort();
    setActiveId(null);
    setStreaming(null);
    setError(null);
    setDraft("");
    setAttachments([]);
  }, []);

  const attachFiles = React.useCallback(async (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/") && f.size <= MAX_ATTACHMENT_BYTES);
    if (!images.length) return;
    const next = await Promise.all(images.map(readAsDataUrl));
    setAttachments((a) => [...a, ...next]);
  }, []);

  /** Renames a thread from its first exchange, but only while it has a placeholder title. */
  const retitle = React.useCallback(async (conversationId: string, seed: string, reply: string) => {
    const conversation = await db.conversations.get(conversationId);
    if (!conversation) return;
    const placeholders = new Set(["New chat", "Image chat", seed.slice(0, 48)]);
    if (!placeholders.has(conversation.title)) return;
    const title = await suggestTitle(seed, reply);
    if (title && title !== conversation.title) await renameConversation(conversationId, title);
  }, []);

  const runTurn = React.useCallback(
    async (conversationId: string, titleSeed?: string) => {
      if (!config || busyRef.current) return;
      busyRef.current = true;
      const provider = config.activeProvider;
      const model = activeModel(config);
      const controller = new AbortController();
      abortRef.current = controller;
      const toolNames = caps.tools ? AGENT_TOOL_NAMES : undefined;
      let titled = false;

      try {
        for (let step = 0; step < MAX_TURN_STEPS; step++) {
          const stored = await db.messages
            .where("conversationId")
            .equals(conversationId)
            .sortBy("createdAt");
          const apiMessages = toApiMessages(stored);

          setStreaming({ text: "", reasoning: "" });
          const result = await streamReply(apiMessages, {
            effort: caps.reasoning ? effort : undefined,
            tools: toolNames,
            signal: controller.signal,
            onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
            onReasoning: (t) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + t } : s)),
          });

          const parts: MessagePart[] = [];
          if (result.reasoning.trim()) parts.push({ type: "reasoning", text: result.reasoning });
          if (result.text.trim()) parts.push({ type: "text", text: result.text });

          const toolParts: MessagePart[] = [];
          let awaitingConfirm = false;
          for (const call of result.toolCalls ?? []) {
            const args = parseToolArguments(call.function.arguments);
            const exec = await executeTool(call.function.name, args);
            if (exec.confirmation) {
              awaitingConfirm = true;
              toolParts.push({
                type: "tool",
                call: {
                  id: call.id,
                  name: call.function.name,
                  args: exec.confirmation.payload,
                  status: "pending",
                  summary: exec.summary,
                },
              });
            } else {
              toolParts.push({
                type: "tool",
                call: {
                  id: call.id,
                  name: call.function.name,
                  args,
                  status: exec.error ? "error" : "done",
                  summary: exec.summary,
                  result: exec.result,
                  error: exec.error,
                },
              });
            }
          }

          const allParts = [...parts, ...toolParts];
          if (allParts.length) {
            await addMessage(conversationId, "assistant", allParts, { provider, model });
          }
          await touchConversation(conversationId, { provider, model });
          setStreaming(null);
          setTokensPerSecond(result.tokensPerSecond);

          if (!titled && titleSeed) {
            titled = true;
            void retitle(conversationId, titleSeed, result.text);
          }

          if (result.aborted) return;
          if (result.error) {
            setError(result.error);
            return;
          }
          if (awaitingConfirm) return;
          if (!result.toolCalls?.length) return;
        }
        setError("The agent reached its step limit for this turn.");
      } finally {
        setStreaming(null);
        busyRef.current = false;
        abortRef.current = null;
      }
    },
    [config, caps.reasoning, caps.tools, effort, retitle],
  );

  const send = React.useCallback(async () => {
    if (!config || streaming || !aiReady || busyRef.current) return;
    const text = draft.trim();
    const images = attachments;
    if (!text && images.length === 0) return;

    setError(null);
    let conversationId = activeId;
    if (!conversationId) {
      const created = await createConversation(
        config.activeProvider,
        activeModel(config),
        text ? text.slice(0, 48) : "Image chat",
      );
      conversationId = created.id;
      setActiveId(created.id);
    }

    const parts: MessagePart[] = [];
    if (text) parts.push({ type: "text", text });
    for (const image of images) parts.push({ type: "image", image });
    await addMessage(conversationId, "user", parts);

    setDraft("");
    setAttachments([]);
    if (text) setHistory((h) => [...h, text].slice(-50));

    await runTurn(conversationId, text || "Image chat");
  }, [config, streaming, aiReady, draft, attachments, activeId, runTurn]);

  const onConfirmTool = React.useCallback(
    async (messageId: string, call: ToolCallData) => {
      if (!activeId || busyRef.current) return;
      await patchToolCall(messageId, call.id, { status: "running", summary: "Creating the batch job…" });
      const exec = await confirmBatchJob(call.args);
      await patchToolCall(messageId, call.id, {
        status: exec.error ? "error" : "done",
        summary: exec.summary,
        result: exec.result,
        error: exec.error,
      });
      await runTurn(activeId);
    },
    [activeId, runTurn],
  );

  const onCancelTool = React.useCallback(async (messageId: string, call: ToolCallData) => {
    await patchToolCall(messageId, call.id, {
      status: "error",
      summary: "Cancelled before anything was created",
      error: "The user cancelled this batch job.",
    });
  }, []);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const commands: SlashCommand[] = [
    { name: "new", description: "Start a new chat", run: newChat },
    {
      name: "clear",
      description: "Delete this chat's messages",
      run: () => {
        if (activeId) void deleteConversation(activeId).then(() => setActiveId(null));
      },
    },
    {
      name: "reasoning",
      description: "Cycle reasoning effort",
      run: () => setEffort((e) => (e === "low" ? "medium" : e === "medium" ? "high" : "low")),
    },
  ];

  const streamingMessage: ChatMessage | null = streaming
    ? {
        id: "__streaming__",
        conversationId: activeId ?? "",
        role: "assistant",
        parts: [
          ...(streaming.reasoning ? [{ type: "reasoning", text: streaming.reasoning } as MessagePart] : []),
          { type: "text", text: streaming.text } as MessagePart,
        ],
        model: activeModel(cfg),
        createdAt: Date.now(),
      }
    : null;

  const providerLabel = activeProvider(cfg)?.label ?? "AI";

  return (
    <div className="flex h-full min-h-0">
      <SessionsRail
        conversations={conversations}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id);
          setError(null);
        }}
        onNew={newChat}
        onRename={(id, title) => void renameConversation(id, title)}
        onTogglePin={(id, pinned) => void setConversationPinned(id, pinned)}
        onDelete={(id) => {
          void deleteConversation(id).then(() => {
            if (id === activeId) setActiveId(null);
          });
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border-subtle px-4 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">Agent</div>
            <div className="truncate text-[11px] text-ink-subtle">
              {aiReady
                ? `${providerLabel}${activeModel(cfg) ? ` · ${activeModel(cfg)}` : ""}`
                : "No AI provider configured"}
            </div>
          </div>
          <a
            href="/settings"
            className="ml-auto flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-ink-muted hover:bg-surface-muted hover:text-ink"
          >
            <SettingsIcon className="h-3.5 w-3.5" /> Providers
          </a>
        </header>

        <Transcript
          messages={messages}
          streaming={streamingMessage}
          error={error}
          onConfirmTool={(id, call) => void onConfirmTool(id, call)}
          onCancelTool={(id, call) => void onCancelTool(id, call)}
          emptyHint={
            !aiReady && (
              <a
                href="/settings"
                className="inline-flex items-center gap-1.5 rounded-md bg-forest px-3 py-1.5 text-[12px] font-medium text-white hover:bg-forest-deep"
              >
                <SettingsIcon className="h-3.5 w-3.5" /> Add an AI provider key
              </a>
            )
          }
        />

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          onStop={stop}
          streaming={!!streaming}
          disabled={!aiReady}
          canAttach={caps.vision}
          attachments={attachments}
          onAttachFiles={(files) => void attachFiles(files)}
          onRemoveAttachment={(i) => setAttachments((a) => a.filter((_, idx) => idx !== i))}
          history={history}
          commands={commands}
          header={
            <>
              <ModelPicker
                activeProviderId={cfg.activeProvider}
                activeModelId={activeModel(cfg)}
                groups={groups}
                favorites={favorites}
                onSelect={(p, m) => void onSelectModel(p, m)}
                onToggleFavorite={(p, m) => void onToggleFavorite(p, m)}
                onRefresh={(p) => void onRefreshModels(p)}
              />
              {caps.reasoning && <EffortPill value={effort} onChange={setEffort} />}
            </>
          }
        />

        <StatusBar
          providerLabel={providerLabel}
          model={activeModel(cfg)}
          contextTokens={contextTokens}
          contextWindow={activeInfo?.contextLength}
          tokensPerSecond={tokensPerSecond}
          streaming={!!streaming}
        />
      </div>
    </div>
  );
}
