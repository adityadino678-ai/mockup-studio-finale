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
  return (
    (data as { error?: { message?: string } })?.error?.message ??
    (data as { message?: string })?.message ??
    `AI provider request failed with HTTP ${res.status}`
  );
}

/** Authorization header for a provider, or `{}` when the provider needs no key. */
function authFor(provider: string, apiKey: string): Record<string, string> {
  const def = getProvider(provider);
  if (!def) return apiKey.trim() ? { Authorization: `Bearer ${apiKey}` } : {};
  return authHeaders(def, apiKey);
}

/** Default completion budget, raised for reasoning turns so thinking cannot starve the answer. */
const DEFAULT_MAX_TOKENS = 1400;
const REASONING_MAX_TOKENS = 3000;

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
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${chatPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authFor(provider, apiKey),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      [tokenParam(provider)]: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: options.signal,
    cache: "no-store",
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(
      (data as { error?: { message?: string } })?.error?.message ??
        `AI request failed with HTTP ${res.status}`,
    );
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
  const choice = (data as { choices?: Array<{ delta?: Record<string, unknown> }> })?.choices?.[0];
  const delta = (choice?.delta ?? {}) as Record<string, unknown>;
  const events: AiStreamEvent[] = [];
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string" && reasoning) events.push({ type: "reasoning", text: reasoning });
  if (typeof delta.content === "string" && delta.content) events.push({ type: "delta", text: delta.content });
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
  const budget = options.maxTokens ?? (options.effort ? REASONING_MAX_TOKENS : DEFAULT_MAX_TOKENS);
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

  let res = await post(initial);
  if (!res.ok) {
    const message = await readAiError(res);
    const retry = retryFix(initial, message);
    if (!retry) throw new Error(message);
    res = await post(retry);
    if (!res.ok) throw new Error(await readAiError(res));
  }
  if (!res.body) throw new Error("AI provider returned no response stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        for (const event of parseProviderStreamLine(line)) {
          if (event.type === "done") finished = true;
          if (event.type === "tool_delta") {
            const current = toolCalls.get(event.index) ?? { id: "", name: "", args: "" };
            if (event.id) current.id = event.id;
            if (event.name) current.name = event.name;
            if (event.args) current.args += event.args;
            toolCalls.set(event.index, current);
            continue;
          }
          yield event;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const calls: AiToolCall[] = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: call.id || `call_${index}`,
      type: "function" as const,
      function: { name: call.name, arguments: call.args },
    }))
    .filter((call) => call.function.name);
  if (calls.length) yield { type: "tool_calls", calls };
  if (!finished) yield { type: "done" };
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
