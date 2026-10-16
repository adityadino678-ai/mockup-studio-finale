"use client";

// Browser-side storage for user-supplied integration keys.
//
// Keys live only in this origin's IndexedDB and are attached to the relevant
// API requests as headers. They are never sent anywhere by default, are never
// written to the server, and can be cleared at any time from Settings. Server
// secrets (PRINTIFY_API_KEY / AI_API_KEY) still work as a fallback when no key
// is saved here.

import { getSetting, setSetting } from "@/lib/db/schema";

export interface IntegrationConfig {
  printifyKey: string;
  aiKey: string;
  aiBaseUrl: string;
  aiModel: string;
}

export const EMPTY_INTEGRATIONS: IntegrationConfig = {
  printifyKey: "",
  aiKey: "",
  aiBaseUrl: "",
  aiModel: "",
};

const SETTINGS_KEY = "integrations";

export async function loadIntegrations(): Promise<IntegrationConfig> {
  const stored = await getSetting<Partial<IntegrationConfig>>(SETTINGS_KEY, {});
  return { ...EMPTY_INTEGRATIONS, ...stored };
}

export async function saveIntegrations(config: IntegrationConfig): Promise<void> {
  await setSetting(SETTINGS_KEY, config);
}

export async function clearIntegrations(): Promise<void> {
  await setSetting(SETTINGS_KEY, EMPTY_INTEGRATIONS);
}

/** Builds the credential headers for a fetch request from a config object. */
export function integrationHeaders(config: IntegrationConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const printifyKey = config.printifyKey.trim();
  const aiKey = config.aiKey.trim();
  const aiBaseUrl = config.aiBaseUrl.trim();
  const aiModel = config.aiModel.trim();
  if (printifyKey) headers["x-printify-key"] = printifyKey;
  if (aiKey) headers["x-ai-key"] = aiKey;
  if (aiBaseUrl) headers["x-ai-base-url"] = aiBaseUrl;
  if (aiModel) headers["x-ai-model"] = aiModel;
  return headers;
}

/**
 * `fetch` that automatically attaches any saved integration keys. Use this for
 * every `/api/**` call that talks to Printify or an AI provider.
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const config = await loadIntegrations();
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(integrationHeaders(config))) {
    headers.set(key, value);
  }
  return fetch(input, { ...init, headers });
}

export function hasAnyKey(config: IntegrationConfig): boolean {
  return !!(config.printifyKey.trim() || config.aiKey.trim());
}
