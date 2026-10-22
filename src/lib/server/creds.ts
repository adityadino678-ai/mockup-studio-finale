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
//
// Background removal follows the same rule: `x-bg-remove-provider` picks the
// engine and `x-bg-remove-key` carries its key, with a server secret as the
// fallback. Gemini is the exception — it IS Google AI Studio, so it reuses the
// AI key.

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
  bgRemove?: BgRemoveCredentials;
}

/**
 * The background-removal providers that can be called from the server.
 *
 * `remove-bg` and `photoroom` are dedicated cutout APIs and need their own
 * key. `gemini` is different: it is Google AI Studio, so it reuses the AI
 * key the visitor already pasted under AI providers.
 */
export type BgRemoveProvider = "remove-bg" | "photoroom" | "gemini";

export interface BgRemoveCredentials {
  apiKey: string;
  provider: BgRemoveProvider;
  source: CredentialSource;
}

const BG_REMOVE_PROVIDERS: readonly string[] = ["remove-bg", "photoroom", "gemini"];

/**
 * Turns a raw header value into a known provider id.
 *
 * The header is attacker-controlled, so an unknown value must never reach a
 * URL. Anything unrecognised resolves to `undefined` and the caller falls
 * back to the default provider.
 */
export function parseBgRemoveProvider(value: string | null | undefined): BgRemoveProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return BG_REMOVE_PROVIDERS.includes(normalized) ? (normalized as BgRemoveProvider) : undefined;
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
 *   x-bg-remove-provider  background-removal provider id
 *   x-bg-remove-key       background-removal API key
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

  // --- background removal -------------------------------------------------
  // The provider is chosen by the browser (the Settings picker), and only the
  // three known ids are honoured — the value is never interpolated into a URL
  // unvalidated.
  const bgRemoveProvider = parseBgRemoveProvider(headers.get("x-bg-remove-provider")) ?? "remove-bg";
  const browserBgRemoveKey = clean(headers.get("x-bg-remove-key"));
  let bgRemoveKey: string | undefined;
  let bgRemoveSource: CredentialSource = "server";
  if (bgRemoveProvider === "gemini") {
    // Gemini IS Google AI Studio, so it reuses the AI key the visitor pasted
    // under AI providers — `x-bg-remove-key` is not required for it. The
    // dedicated header still wins when present, so a visitor can keep a
    // Google key for cutouts separate from their chat provider.
    bgRemoveKey = browserBgRemoveKey ?? aiKey;
    bgRemoveSource = browserBgRemoveKey || browserAiKey ? "browser" : "server";
  } else {
    // remove.bg and PhotoRoom are separate services with their own keys.
    bgRemoveKey = browserBgRemoveKey ?? clean(serverEnv.bgRemoveApiKey());
    bgRemoveSource = browserBgRemoveKey ? "browser" : "server";
  }

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
    bgRemove: bgRemoveKey
      ? { apiKey: bgRemoveKey, provider: bgRemoveProvider, source: bgRemoveSource }
      : undefined,
  };
}

/** Resolves the base URL for a provider id, honouring an optional override. */
export function resolveBaseUrl(providerId: string | undefined, override?: string | null): string {
  const def = getProvider(providerId);
  if (!def) return (override?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  return baseUrlFor(def, override) || DEFAULT_BASE_URL;
}
