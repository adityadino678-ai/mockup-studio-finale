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
//
// AI is provider-aware: the browser sends `x-ai-provider` (an id from
// lib/ai/providers) plus the key/base-url/model. The provider's base URL is used
// unless the user overrides it (the `custom` provider).

import { serverEnv } from "@/lib/server/env";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_ID,
  baseUrlFor,
  getProvider,
} from "@/lib/ai/providers";

export type CredentialSource = "browser" | "server";

export interface PrintifyCredentials {
  apiKey: string;
  source: CredentialSource;
}

export interface AiCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Provider id from lib/ai/providers (`custom` for a free-form endpoint). */
  provider: string;
  source: CredentialSource;
}

export interface Credentials {
  printify?: PrintifyCredentials;
  ai?: AiCredentials;
}

// Re-exported for callers/tests that predate the provider registry.
export const DEFAULT_AI_BASE_URL = DEFAULT_BASE_URL;
export const DEFAULT_AI_MODEL = DEFAULT_MODEL;

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Reads credentials from request headers, falling back to server secrets.
 *
 * Headers (all optional):
 *   x-printify-key   Printify personal access token
 *   x-ai-provider    provider id (lib/ai/providers)
 *   x-ai-key         OpenAI-compatible API key
 *   x-ai-base-url    base URL override (used for the `custom` provider)
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

  const serverBase = clean(serverEnv.aiBaseUrl());
  const providerId = clean(headers.get("x-ai-provider")) ?? (serverBase ? "custom" : DEFAULT_PROVIDER_ID);
  const def = getProvider(providerId) ?? getProvider("custom");

  const browserBase = clean(headers.get("x-ai-base-url"));
  const providerBase = def && def.id !== "custom" ? def.baseUrl : undefined;
  const baseUrl =
    browserBase ?? providerBase ?? serverBase ?? (def?.id === "custom" ? "" : DEFAULT_BASE_URL);

  const model =
    clean(headers.get("x-ai-model")) ?? clean(serverEnv.aiModel()) ?? def?.defaultModel ?? DEFAULT_MODEL;

  return {
    printify: printifyKey
      ? { apiKey: printifyKey, source: browserPrintifyKey ? "browser" : "server" }
      : undefined,
    ai: aiKey
      ? {
          apiKey: aiKey,
          baseUrl: baseUrl || DEFAULT_BASE_URL,
          model,
          provider: def?.id ?? "custom",
          source: browserAiKey ? "browser" : "server",
        }
      : undefined,
  };
}

/** Resolves the base URL for a provider id, honouring an optional override. */
export function resolveBaseUrl(providerId: string | undefined, override?: string | null): string {
  const def = getProvider(providerId);
  if (!def) return (override?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  return baseUrlFor(def, override) || DEFAULT_BASE_URL;
}
