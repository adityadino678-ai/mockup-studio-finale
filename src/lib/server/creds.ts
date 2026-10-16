// Per-request credential resolution.
//
// Integration keys can come from two places:
//   1. The browser — the user pastes their own key in Settings, it is stored in
//      their IndexedDB and sent on each request as a header. Nothing is stored
//      on the server.
//   2. The server — the deployment owner sets a secret (wrangler / .dev.vars).
//
// The browser value wins when present, so a visitor can use their own account
// without the operator configuring anything. Requests that carry no header
// fall back to the server secret, preserving the original behaviour.

import { serverEnv } from "@/lib/server/env";

export type CredentialSource = "browser" | "server";

export interface PrintifyCredentials {
  apiKey: string;
  source: CredentialSource;
}

export interface AiCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
  source: CredentialSource;
}

export interface Credentials {
  printify?: PrintifyCredentials;
  ai?: AiCredentials;
}

export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_AI_MODEL = "gpt-4o-mini";

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Reads credentials from request headers, falling back to server secrets.
 *
 * Headers (all optional):
 *   x-printify-key   Printify personal access token
 *   x-ai-key         OpenAI-compatible API key
 *   x-ai-base-url    OpenAI-compatible base URL
 *   x-ai-model       model id
 */
export function credentialsFromRequest(request: Request): Credentials {
  const headers = request.headers;

  const browserPrintifyKey = clean(headers.get("x-printify-key"));
  const serverPrintifyKey = clean(serverEnv.printifyApiKey());
  const printifyKey = browserPrintifyKey ?? serverPrintifyKey;

  const browserAiKey = clean(headers.get("x-ai-key"));
  const serverAiKey = clean(serverEnv.aiApiKey()) ?? clean(serverEnv.openaiApiKey());
  const aiKey = browserAiKey ?? serverAiKey;

  const baseUrl =
    clean(headers.get("x-ai-base-url")) ?? clean(serverEnv.aiBaseUrl()) ?? DEFAULT_AI_BASE_URL;
  const model = clean(headers.get("x-ai-model")) ?? clean(serverEnv.aiModel()) ?? DEFAULT_AI_MODEL;

  return {
    printify: printifyKey
      ? { apiKey: printifyKey, source: browserPrintifyKey ? "browser" : "server" }
      : undefined,
    ai: aiKey ? { apiKey: aiKey, baseUrl, model, source: browserAiKey ? "browser" : "server" } : undefined,
  };
}
