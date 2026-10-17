"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Menu, Settings as SettingsIcon, PanelRight } from "lucide-react";
import { db, getSetting, setSetting } from "@/lib/db/schema";
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
  newId,
  patchToolCall,
  renameConversation,
  saveFavorites,
  setConversationPinned,
  streamReply,
  suggestTitle,
  toApiMessages,
  touchConversation,
} from "@/lib/client/chat";
import { CONFIRM_TOOL_RUNNERS, executeTool } from "@/lib/client/tools";
import { AGENT_TOOL_NAMES, parseToolArguments, routeIntent } from "@/lib/ai/tools";
import {
  favoriteKey,
  modelCapabilities,
  providerList,
  type ModelInfo,
  type ReasoningEffort,
} from "@/lib/ai/providers";
import { SessionsRail } from "@/components/agent/sessions-rail";
import { Transcript } from "@/components/agent/transcript";
import { ArtifactRail } from "@/components/agent/artifact-rail";
import {
  recognitionSupported,
  speak,
  speechTextFromParts,
  startDictation,
  stopSpeaking,
  synthesisSupported,
  type Dictation,
} from "@/lib/client/speech";
import { Composer, type SlashCommand } from "@/components/agent/composer";
import { ModelPicker, type ProviderModels } from "@/components/agent/model-picker";
import { EffortPill } from "@/components/agent/effort-pill";
import { StatusBar } from "@/components/agent/status-bar";
import { DebugPanel, type DebugEntry } from "@/components/agent/debug-panel";
import type { ChatMessage, ImagePartData, MessagePart, ToolCallData } from "@/types/domain";
import { cn } from "@/lib/utils";

const MAX_TURN_STEPS = 6;

interface StreamState {
  text: string;
  reasoning: string;
}

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** Images the user attached on the latest user turn of a conversation. */
async function attachmentsFromConversation(conversationId: string): Promise<ImagePartData[]> {
  const stored = await db.messages
    .where("conversationId")
    .equals(conversationId)
    .sortBy("createdAt");
  const lastUser = [...stored].reverse().find((m) => m.role === "user");
  return (
    lastUser?.parts
      .filter((p): p is { type: "image"; image: ImagePartData } => p.type === "image")
      .map((p) => p.image) ?? []
  );
}

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
  const [sessionsOpen, setSessionsOpen] = React.useState(false);
  const [artifactsOpen, setArtifactsOpen] = React.useState(true);
  const [listening, setListening] = React.useState(false);
  const [speakReplies, setSpeakReplies] = React.useState(false);
  const [queue, setQueue] = React.useState<string[]>([]);
  const debug = React.useMemo(
    () => (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug")),
    [],
  );
  const [debugEntries, setDebugEntries] = React.useState<DebugEntry[]>([]);
  const [debugOpen, setDebugOpen] = React.useState(true);
  const abortRef = React.useRef<AbortController | null>(null);
  const busyRef = React.useRef(false);
  const dictationRef = React.useRef<Dictation | null>(null);
  const queueRef = React.useRef<string[]>([]);
  const sendTextRef = React.useRef<(text: string, images: ImagePartData[]) => void>(() => {});

  const voiceSupported = React.useMemo(
    () => recognitionSupported() || synthesisSupported(),
    [],
  );

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
      const [c, fav, voicePref, status] = await Promise.all([
        loadIntegrations(),
        loadFavorites(),
        getSetting<boolean>("ai:speakReplies", false),
        authedFetch("/api/integrations/status")
          .then((r) => r.json())
          .catch(() => null),
      ]);
      setConfig(c);
      setFavorites(fav);
      setSpeakReplies(!!voicePref);
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

  React.useEffect(
    () => () => {
      dictationRef.current?.abort();
      stopSpeaking();
    },
    [],
  );

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
    queueRef.current = [];
    setQueue([]);
    setSessionsOpen(false);
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

  const logDebug = React.useCallback((kind: DebugEntry["kind"], label: string, body?: string) => {
    setDebugEntries((prev) => {
      const next = [...prev, { id: newId(), kind, label, body }];
      return next.length > 600 ? next.slice(next.length - 600) : next;
    });
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
      let spoken = "";
      // Fallback state: a turn the user started may run a routed tool or a
      // one-shot nudge when the model answers without calling anything.
      const userInitiated = !!titleSeed;
      let routed = false;
      let nudged = false;
      let nudge: string | undefined;
      let lastUserText = "";
      let turnAttachments: ImagePartData[] = [];
      if (userInitiated) {
        const seedMessages = await db.messages
          .where("conversationId")
          .equals(conversationId)
          .sortBy("createdAt");
        const lastUser = [...seedMessages].reverse().find((m) => m.role === "user");
        lastUserText =
          lastUser?.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join(" ")
            .trim() ?? "";
        turnAttachments =
          lastUser?.parts
            .filter((p): p is { type: "image"; image: ImagePartData } => p.type === "image")
            .map((p) => p.image) ?? [];
      }
      if (debug) logDebug("turn", `turn · ${provider} · ${model} · tools: ${toolNames?.length ?? 0}`);

      try {
        for (let step = 0; step < MAX_TURN_STEPS; step++) {
          const stored = await db.messages
            .where("conversationId")
            .equals(conversationId)
            .sortBy("createdAt");
          const apiMessages = toApiMessages(stored);
          if (nudge) {
            apiMessages.push({ role: "user", content: nudge });
            nudge = undefined;
          }

          if (debug) {
            logDebug(
              "request",
              `step ${step + 1} · ${apiMessages.length} messages`,
              JSON.stringify(
                {
                  provider,
                  model,
                  effort: caps.reasoning ? effort : null,
                  tools: toolNames ?? [],
                  messages: apiMessages.length,
                },
                null,
                2,
              ),
            );
          }

          setStreaming({ text: "", reasoning: "" });
          const result = await streamReply(apiMessages, {
            effort: caps.reasoning ? effort : undefined,
            tools: toolNames,
            signal: controller.signal,
            debug,
            onFrame: debug
              ? (frame) => logDebug("frame", `event: ${frame.event}`, frame.data)
              : undefined,
            onDelta: (t) => setStreaming((s) => (s ? { ...s, text: s.text + t } : s)),
            onReasoning: (t) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + t } : s)),
          });

          // Decide what to run: the model's own tool calls, or — when it asked
          // for none on a user-initiated turn — the tool the router matched.
          // This is what makes the agent act on models that only chat.
          let callsToRun = result.toolCalls ?? [];
          let routedThisStep = false;
          if (
            !callsToRun.length &&
            !result.error &&
            !result.aborted &&
            userInitiated &&
            !routed &&
            toolNames?.length
          ) {
            const intent = routeIntent(lastUserText);
            if (intent && toolNames.includes(intent.name)) {
              callsToRun = [
                {
                  id: `route_${newId()}`,
                  type: "function",
                  function: { name: intent.name, arguments: JSON.stringify(intent.args) },
                },
              ];
              routed = true;
              routedThisStep = true;
            }
          }

          const parts: MessagePart[] = [];
          if (result.reasoning.trim()) parts.push({ type: "reasoning", text: result.reasoning });
          if (result.text.trim() && !routedThisStep) parts.push({ type: "text", text: result.text });

          const toolParts: MessagePart[] = [];
          let awaitingConfirm = false;
          for (const call of callsToRun) {
            const args = parseToolArguments(call.function.arguments);
            const exec = await executeTool(call.function.name, args, { attachments: turnAttachments });
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
          spoken = result.text;

          if (debug) {
            logDebug(
              "summary",
              `step ${step + 1} result`,
              JSON.stringify(
                {
                  textLen: result.text.length,
                  reasoningLen: result.reasoning.length,
                  toolCalls: result.toolCalls?.length ?? 0,
                  ran: callsToRun.length,
                  routed: routedThisStep,
                  error: result.error ?? null,
                  aborted: result.aborted,
                  firstTokenMs: result.firstTokenMs ?? null,
                  tokensPerSecond: result.tokensPerSecond ?? null,
                },
                null,
                2,
              ),
            );
          }

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
          // A tool ran this step — loop so the model can use the result.
          if (callsToRun.length) continue;

          // No tool ran. Guard against the "reasoning-only" and empty answers
          // that make the agent look like it said nothing.
          if (!result.text.trim() && result.reasoning.trim() && !nudged) {
            nudged = true;
            nudge =
              "You produced reasoning but no visible answer. Give your final answer now as plain text, and do not repeat the reasoning.";
            continue;
          }
          if (!result.text.trim() && result.reasoning.trim()) {
            setError("The model produced reasoning but no answer. Try again or switch to a different model.");
            return;
          }
          if (!result.text.trim()) {
            setError("The model returned an empty response. Try again or switch to a different model.");
            return;
          }
          return;
        }
        setError("The agent reached its step limit for this turn.");
      } finally {
        setStreaming(null);
        busyRef.current = false;
        abortRef.current = null;
        if (speakReplies && spoken.trim()) {
          speak(speechTextFromParts([{ type: "text", text: spoken }]));
        }
        const next = queueRef.current.shift();
        if (next !== undefined) {
          setQueue(queueRef.current.slice());
          sendTextRef.current(next, []);
        }
      }
    },
    [config, caps.reasoning, caps.tools, effort, retitle, speakReplies, debug, logDebug],
  );

  const sendText = React.useCallback(
    async (text: string, images: ImagePartData[]) => {
      if (!config || !aiReady) return;
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
      if (text) setHistory((h) => [...h, text].slice(-50));

      await runTurn(conversationId, text || "Image chat");
    },
    [config, aiReady, activeId, runTurn],
  );

  React.useEffect(() => {
    sendTextRef.current = (text, images) => void sendText(text, images);
  }, [sendText]);

  const send = React.useCallback(() => {
    if (!config || !aiReady) return;
    const text = draft.trim();
    const images = attachments;
    if (!text && images.length === 0) return;

    setDraft("");
    setAttachments([]);

    // While a reply is streaming, hold the message and send it when the turn ends.
    if (busyRef.current || streaming) {
      if (!text) return;
      queueRef.current = [...queueRef.current, text];
      setQueue(queueRef.current.slice());
      return;
    }
    void sendText(text, images);
  }, [config, aiReady, draft, attachments, streaming, sendText]);

  const toggleVoice = React.useCallback(() => {
    if (listening) {
      dictationRef.current?.stop();
      dictationRef.current = null;
      setListening(false);
      return;
    }
    const session = startDictation({
      onResult: (text, isFinal) => {
        if (!isFinal) return;
        setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}${text.trim()}`);
      },
      onError: () => setListening(false),
      onEnd: () => setListening(false),
    });
    if (session) {
      dictationRef.current = session;
      setListening(true);
    }
  }, [listening]);

  const toggleSpeak = React.useCallback(() => {
    setSpeakReplies((v) => {
      const next = !v;
      void setSetting("ai:speakReplies", next);
      if (!next) stopSpeaking();
      return next;
    });
  }, []);

  const onConfirmTool = React.useCallback(
    async (messageId: string, call: ToolCallData) => {
      if (!activeId || busyRef.current) return;
      const runner = CONFIRM_TOOL_RUNNERS[call.name];
      if (!runner) {
        await patchToolCall(messageId, call.id, {
          status: "error",
          summary: "Nothing to confirm",
          error: `No confirmation handler for "${call.name}".`,
        });
        return;
      }
      await patchToolCall(messageId, call.id, { status: "running", summary: "Working…" });
      const ctx = { attachments: await attachmentsFromConversation(activeId) };
      const exec = await runner(call.args, ctx);
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

  const onCancelTool = React.useCallback(
    async (messageId: string, call: ToolCallData) => {
      await patchToolCall(messageId, call.id, {
        status: "error",
        summary: "Cancelled before anything was created",
        error: `The user cancelled this ${call.name.replace(/_/g, " ")}.`,
      });
    },
    [],
  );

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
      {sessionsOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setSessionsOpen(false)}
          aria-hidden
        />
      )}
      <div className={cn("shrink-0", sessionsOpen ? "fixed inset-y-0 left-0 z-40 lg:static" : "hidden lg:block")}>
        <SessionsRail
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            setError(null);
            setSessionsOpen(false);
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
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
          <button
            type="button"
            onClick={() => setSessionsOpen(true)}
            className="rounded-md p-1.5 text-ink-muted hover:bg-surface-muted hover:text-ink lg:hidden"
            title="Chats"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">Agent</div>
            <div className="truncate text-[11px] text-ink-subtle">
              {aiReady
                ? `${providerLabel}${activeModel(cfg) ? ` · ${activeModel(cfg)}` : ""}`
                : "No AI provider configured"}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setArtifactsOpen((v) => !v)}
              className={cn(
                "hidden rounded-md border border-border-subtle p-1.5 xl:flex",
                artifactsOpen ? "text-forest" : "text-ink-muted hover:text-ink",
              )}
              title={artifactsOpen ? "Hide workspace rail" : "Show workspace rail"}
              aria-pressed={artifactsOpen}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
            {debug && (
              <button
                type="button"
                onClick={() => setDebugOpen((v) => !v)}
                className={cn(
                  "rounded-md border border-border-subtle px-2 py-1.5 text-[11px]",
                  debugOpen ? "text-forest" : "text-ink-muted hover:text-ink",
                )}
                title="Toggle SSE debug capture"
                aria-pressed={debugOpen}
              >
                Debug
              </button>
            )}
            <a
              href="/settings"
              className="flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-ink-muted hover:bg-surface-muted hover:text-ink"
            >
              <SettingsIcon className="h-3.5 w-3.5" /> Providers
            </a>
          </div>
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
          voiceSupported={voiceSupported && recognitionSupported()}
          listening={listening}
          onToggleVoice={toggleVoice}
          speakReplies={speakReplies}
          onToggleSpeak={synthesisSupported() ? toggleSpeak : undefined}
          queuedCount={queue.length}
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

      {artifactsOpen && (
        <div className="hidden xl:flex">
          <ArtifactRail onClose={() => setArtifactsOpen(false)} />
        </div>
      )}

      {debug && debugOpen && (
        <DebugPanel
          entries={debugEntries}
          onClear={() => setDebugEntries([])}
          onClose={() => setDebugOpen(false)}
        />
      )}
    </div>
  );
}
