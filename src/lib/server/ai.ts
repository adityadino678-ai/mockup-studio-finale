// Server-side AI provider. Speaks the OpenAI-compatible chat completions API so
// any compatible endpoint works. Credentials may come from the environment or,
// when a visitor pastes their own key in Settings, from the request headers —
// see `lib/server/creds.ts`. Keys are never persisted on the server. When
// unconfigured, callers get an explicit error instead of fabricated content.

import { serverEnv } from "@/lib/server/env";
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, type AiCredentials } from "@/lib/server/creds";
import { authHeaders, baseUrlFor, getProvider, normalizeModels, type ModelInfo } from "@/lib/ai/providers";
import type { OpenAiToolDef } from "@/lib/ai/tools";

export type AiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A tool call the model asked for, in the OpenAI-compatible wire shape. */
export interface AiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AiContentPart[] | null;
  /** Present on assistant messages that requested one or more tools. */
  tool_calls?: AiToolCall[];
  /** Present on `role: "tool"` messages; ties the result back to its call. */
  tool_call_id?: string;
  /**
   * DeepSeek-style providers require the assistant's reasoning to be echoed back
   * on every later request that carries `tools`. Only such providers receive it;
   * the endpoint strips it for everyone else.
   */
  reasoning_content?: string;
}

export interface AiCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export function aiConfig(creds?: AiCredentials): { configured: boolean; baseUrl: string; model: string; provider: string } {
  if (creds) {
    return { configured: true, baseUrl: creds.baseUrl, model: creds.model, provider: creds.provider };
  }
  const key = serverEnv.aiApiKey() || serverEnv.openaiApiKey();
  const baseUrl = serverEnv.aiBaseUrl() || DEFAULT_AI_BASE_URL;
  const model = serverEnv.aiModel() || DEFAULT_AI_MODEL;
  const provider = serverEnv.aiBaseUrl() ? "custom" : "openai";
  return { configured: !!key, baseUrl, model, provider };
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "AI provider is not configured. Paste your API key in Settings, or ask the operator to set AI_API_KEY, then try again.",
    );
    this.name = "AiNotConfiguredError";
  }
}

async function readAiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const record = data as
    | { error?: { message?: string } | string; message?: unknown; detail?: unknown }
    | null;
  const errorField = record?.error;
  const message =
    (typeof errorField === "string" ? errorField : errorField?.message) ??
    (typeof record?.message === "string" ? record.message : undefined) ??
    (typeof record?.detail === "string" ? record.detail : undefined);
  if (message) return message;
  // FastAPI (NVIDIA NIM, some gateways) uses `detail`; unrecognised shapes still
  // get a readable hint instead of a bare status code.
  const raw = (typeof data === "string" ? data : text).replace(/\s+/g, " ").trim().slice(0, 180);
  return raw
    ? `AI provider request failed with HTTP ${res.status}: ${raw}`
    : `AI provider request failed with HTTP ${res.status}`;
}

/** Authorization header for a provider, or `{}` when the provider needs no key. */
function authFor(provider: string, apiKey: string): Record<string, string> {
  const def = getProvider(provider);
  if (!def) return apiKey.trim() ? { Authorization: `Bearer ${apiKey}` } : {};
  return authHeaders(def, apiKey);
}

// Reasoning models stream their chain of thought into a separate `reasoning`
// channel and the real answer into `content`. The token budget counts BOTH, so
// a reasoning turn needs far more headroom than a plain answer — otherwise the
// model spends the whole budget thinking and never produces visible text.
const DEFAULT_MAX_TOKENS = 2000;
const REASONING_MAX_TOKENS = 8000;

/**
 * The output token budget for a turn. An explicit `maxTokens` (the client
 * escalating after a truncated reply) always wins; otherwise reasoning turns
 * get the larger budget so thinking cannot starve the answer.
 */
export function outputTokenBudget(options: { maxTokens?: number; effort?: string } = {}): number {
  if (typeof options.maxTokens === "number" && options.maxTokens > 0) return options.maxTokens;
  return options.effort ? REASONING_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}

/**
 * OpenAI's newer models reject `max_tokens` in favour of `max_completion_tokens`.
 * We send the documented parameter per provider and still recover via `retryFix`
 * when a provider disagrees.
 */
function tokenParam(provider: string): "max_tokens" | "max_completion_tokens" {
  return provider === "openai" ? "max_completion_tokens" : "max_tokens";
}

/**
 * Given a provider's error text, returns an adjusted request body for a single
 * retry — dropping or renaming the parameter the provider rejected — or null
 * when the error is not something we can fix by changing the request shape.
 * Exported so the recovery rules are unit-testable without a network.
 */
export function retryFix(body: Record<string, unknown>, message: string): Record<string, unknown> | null {
  const lower = message.toLowerCase();
  const next: Record<string, unknown> = { ...body };
  let changed = false;
  if (lower.includes("reasoning_effort") && "reasoning_effort" in next) {
    delete next.reasoning_effort;
    changed = true;
  }
  if (lower.includes("temperature") && "temperature" in next) {
    delete next.temperature;
    changed = true;
  }
  if (lower.includes("max_completion_tokens") && "max_tokens" in next) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    changed = true;
  } else if (lower.includes("max_tokens") && "max_completion_tokens" in next) {
    next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
    changed = true;
  }
  if (/\btools?\b|\bfunctions?\b/.test(lower) && "tools" in next) {
    delete next.tools;
    delete next.tool_choice;
    changed = true;
  }
  // A raised reasoning budget can exceed a provider's own cap; clamp it down so
  // the turn still answers instead of failing outright.
  const tokenKey = "max_completion_tokens" in next ? "max_completion_tokens" : "max_tokens" in next ? "max_tokens" : null;
  if (
    tokenKey &&
    /max[_ ]?(completion_)?tokens/.test(lower) &&
    /(too (large|long|big|high)|greater|at most|maximum|exceed|limit|reduce|lower|fewer)/.test(lower)
  ) {
    const value = Number(next[tokenKey]);
    if (Number.isFinite(value) && value > 4096) {
      next[tokenKey] = 4096;
      changed = true;
    }
  }
  return changed ? next : null;
}

export async function complete(
  messages: AiMessage[],
  options: AiCompletionOptions = {},
  creds?: AiCredentials,
): Promise<string> {
  const { configured, baseUrl, model, provider } = aiConfig(creds);
  if (!configured) throw new AiNotConfiguredError();

  const apiKey = creds?.apiKey ?? serverEnv.aiApiKey() ?? serverEnv.openaiApiKey() ?? "";
  const def = getProvider(provider);
  const chatPath = def?.chatPath ?? "/chat/completions";
  const url = `${baseUrl.replace(/\/$/, "")}${chatPath}`;
  const headers = { "Content-Type": "application/json", ...authFor(provider, apiKey) };
  const initial: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    [tokenParam(provider)]: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };
  const post = (body: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
      cache: "no-store",
    });

  // Same multi-attempt fixup as streamChat: a provider can reject more than one
  // field at once, so keep repairing the request until it is accepted.
  let request = initial;
  let res = await post(request);
  for (let tries = 0; !res.ok && tries < 4; tries++) {
    const message = await readAiError(res);
    const fixed = retryFix(request, message);
    if (!fixed) throw new Error(message);
    request = fixed;
    res = await post(request);
  }
  if (!res.ok) throw new Error(await readAiError(res));

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const content = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI provider returned an empty response");
  return content;
}

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

export interface AiStreamOptions {
  temperature?: number;
  maxTokens?: number;
  /** Reasoning effort hint (`low` | `medium` | `high`); only sent when set. */
  effort?: string;
  /** Tool definitions the model may call; only sent when non-empty. */
  tools?: OpenAiToolDef[];
  signal?: AbortSignal;
}

export type AiStreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_delta"; index: number; id?: string; name?: string; args?: string }
  | { type: "tool_calls"; calls: AiToolCall[] }
  | { type: "usage"; usage: Record<string, unknown> }
  | { type: "finish"; reason: string }
  | { type: "done" };

/**
 * Parses one line of an OpenAI-compatible streaming response into normalized
 * events. Exported so the parsing rules are unit-testable without a network.
 */
export function parseProviderStreamLine(line: string): AiStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) return [];
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return [{ type: "done" }];
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return [];
  }
  const choice = (data as {
    choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
  })?.choices?.[0];
  const delta = (choice?.delta ?? {}) as Record<string, unknown>;
  const events: AiStreamEvent[] = [];
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string" && reasoning) events.push({ type: "reasoning", text: reasoning });
  if (typeof delta.content === "string" && delta.content) events.push({ type: "delta", text: delta.content });
  // `finish_reason` tells the client why the turn ended. "length" means the
  // budget was exhausted — the usual cause of a reasoning-only, answerless reply.
  if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
    events.push({ type: "finish", reason: choice.finish_reason });
  }
  const calls = delta.tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      const entry = call as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      events.push({
        type: "tool_delta",
        index: typeof entry.index === "number" ? entry.index : 0,
        id: entry.id,
        name: entry.function?.name,
        args: entry.function?.arguments,
      });
    }
  }
  const usage = (data as { usage?: Record<string, unknown> })?.usage;
  if (usage && typeof usage === "object") events.push({ type: "usage", usage });
  return events;
}

/**
 * Streams a chat completion, yielding normalized events. Throws before the
 * first yield for configuration/HTTP errors so callers can still send a real
 * status code; after the first yield the response is committed.
 */
export async function* streamChat(
  messages: AiMessage[],
  options: AiStreamOptions = {},
  creds?: AiCredentials,
): AsyncGenerator<AiStreamEvent> {
  const { configured, baseUrl, model, provider } = aiConfig(creds);
  if (!configured) throw new AiNotConfiguredError();

  const apiKey = creds?.apiKey ?? serverEnv.aiApiKey() ?? serverEnv.openaiApiKey() ?? "";
  const def = getProvider(provider);
  const chatPath = def?.chatPath ?? "/chat/completions";
  const url = `${baseUrl.replace(/\/$/, "")}${chatPath}`;
  const headers = { "Content-Type": "application/json", ...authFor(provider, apiKey) };
  const budget = outputTokenBudget(options);
  const initial: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: options.temperature ?? 0.7,
    [tokenParam(provider)]: budget,
    ...(options.effort ? { reasoning_effort: options.effort } : {}),
    ...(options.tools?.length ? { tools: options.tools, tool_choice: "auto" } : {}),
  };
  const post = (body: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
      cache: "no-store",
    });

  // A single 400 can name more than one rejected field (OpenAI, for example,
  // rejects both `temperature` and `max_tokens` on its reasoning models), so
  // keep fixing and retrying until the provider accepts the request or the error
  // stops being something we can fix by changing the request shape.
  let request = initial;
  let res = await post(request);
  for (let tries = 0; !res.ok && tries < 4; tries++) {
    const message = await readAiError(res);
    const fixed = retryFix(request, message);
    if (!fixed) throw new Error(message);
    request = fixed;
    res = await post(request);
  }
  if (!res.ok) throw new Error(await readAiError(res));
  if (!res.body) throw new Error("AI provider returned no response stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let buffer = "";

  // Tool-call deltas arrive as fragments, so they are accumulated here rather
  // than yielded; everything else is passed through. The terminal `done` is
  // swallowed too — it is re-emitted once, after the tool calls.
  const absorb = (events: AiStreamEvent[]): AiStreamEvent[] => {
    const out: AiStreamEvent[] = [];
    for (const event of events) {
      if (event.type === "done") continue;
      if (event.type === "tool_delta") {
        const current = toolCalls.get(event.index) ?? { id: "", name: "", args: "" };
        if (event.id) current.id = event.id;
        if (event.name) current.name = event.name;
        if (event.args) current.args += event.args;
        toolCalls.set(event.index, current);
        continue;
      }
      out.push(event);
    }
    return out;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        for (const event of absorb(parseProviderStreamLine(line))) yield event;
      }
    }
    // A provider that closes without a trailing newline would otherwise lose its
    // final line (usually the one carrying `finish_reason`).
    const tail = buffer.trim();
    if (tail) for (const event of absorb(parseProviderStreamLine(tail))) yield event;
  } finally {
    await reader.cancel().catch(() => {});
  }

  // ORDER MATTERS: the client and the API route both stop at `done`, so the
  // accumulated tool calls must be emitted *before* it. Previously they were
  // flushed after the loop while `done` was yielded from inside it, which meant
  // the tool_calls frame was never sent for any provider that ends with
  // `data: [DONE]` — the agent silently ran on the keyword fallback alone.
  const calls: AiToolCall[] = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: call.id || `call_${index}`,
      type: "function" as const,
      function: { name: call.name, arguments: call.args },
    }))
    .filter((call) => call.function.name);
  if (calls.length) yield { type: "tool_calls", calls };
  yield { type: "done" };
}

export interface AiProbe {
  model: string;
  modelCount?: number;
  mode: "models" | "chat";
  ms: number;
}

/**
 * Live connectivity probe. Tries the cheap model list first and falls back to a
 * one-token chat completion for providers that do not implement it. Throws with
 * the provider's own message on failure (bad key, wrong URL, unreachable host).
 */
export async function probeAi(creds: AiCredentials): Promise<AiProbe> {
  const def = getProvider(creds.provider);
  const base = creds.baseUrl.replace(/\/$/, "");
  const chatPath = def?.chatPath ?? "/chat/completions";
  const modelsPath = def?.modelsPath ?? "/models";
  const started = Date.now();
  const auth = authFor(creds.provider, creds.apiKey);

  const modelsRes = await fetch(`${base}${modelsPath}`, { headers: auth, cache: "no-store" });
  if (modelsRes.ok) {
    const data = (await modelsRes.json().catch(() => null)) as { data?: unknown[] } | null;
    return {
      model: creds.model,
      modelCount: Array.isArray(data?.data) ? data.data.length : undefined,
      mode: "models",
      ms: Date.now() - started,
    };
  }
  if (modelsRes.status !== 404 && modelsRes.status !== 405) {
    throw new Error(await readAiError(modelsRes));
  }

  const chatRes = await fetch(`${base}${chatPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      model: creds.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
    cache: "no-store",
  });
  if (!chatRes.ok) throw new Error(await readAiError(chatRes));
  return { model: creds.model, mode: "chat", ms: Date.now() - started };
}

/**
 * Fetches and normalizes a provider's live model list. Falls back to the
 * provider's curated seed list when the endpoint is missing or empty.
 */
export async function listModels(
  providerId: string,
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const def = getProvider(providerId);
  if (!def) throw new Error(`Unknown provider "${providerId}".`);
  const base = baseUrlFor(def, baseUrlOverride) || DEFAULT_AI_BASE_URL;
  const auth = authHeaders(def, apiKey);

  const res = await fetch(`${base}${def.modelsPath}`, { headers: auth, cache: "no-store" });
  if (!res.ok) {
    if (def.fallbackModels?.length) return normalizeModels(def, def.fallbackModels);
    throw new Error(await readAiError(res));
  }
  const raw = await res.json().catch(() => null);
  const models = normalizeModels(def, raw);
  if (!models.length && def.fallbackModels?.length) return normalizeModels(def, def.fallbackModels);
  return models;
}

/** Best-effort JSON parse that tolerates markdown fences. */
export function parseJsonLoose<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
  return JSON.parse(cleaned) as T;
}
