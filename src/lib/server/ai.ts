// Server-side AI provider. Speaks the OpenAI-compatible chat completions API so
// any compatible endpoint works. Credentials may come from the environment or,
// when a visitor pastes their own key in Settings, from the request headers —
// see `lib/server/creds.ts`. Keys are never persisted on the server. When
// unconfigured, callers get an explicit error instead of fabricated content.

import { serverEnv } from "@/lib/server/env";
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, type AiCredentials } from "@/lib/server/creds";
import { authHeaders, baseUrlFor, getProvider, normalizeModels, type ModelInfo } from "@/lib/ai/providers";

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
      max_tokens: options.maxTokens ?? 1400,
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
