// Server-side AI provider. Speaks the OpenAI-compatible chat completions API so
// any compatible endpoint works. The key is read from the environment only and
// never reaches the browser. When unconfigured, callers get an explicit error
// instead of fabricated content.

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

export function aiConfig(): { configured: boolean; baseUrl: string; model: string } {
  const key = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.AI_MODEL || "gpt-4o-mini";
  return { configured: !!key, baseUrl, model };
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "AI provider is not configured. Add AI_API_KEY (and optionally AI_BASE_URL / AI_MODEL) to .env.local, then restart the dev server.",
    );
    this.name = "AiNotConfiguredError";
  }
}

export async function complete(
  messages: AiMessage[],
  options: AiCompletionOptions = {},
): Promise<string> {
  const { configured, baseUrl, model } = aiConfig();
  if (!configured) throw new AiNotConfiguredError();

  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
    const message =
      (data as { error?: { message?: string } })?.error?.message ??
      `AI request failed with HTTP ${res.status}`;
    throw new Error(message);
  }
  const content = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI provider returned an empty response");
  return content;
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