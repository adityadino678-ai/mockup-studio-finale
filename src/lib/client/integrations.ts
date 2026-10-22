"use client";

// Browser-side storage for user-supplied integration keys.
//
// Keys live only in this origin's IndexedDB and are attached to the relevant
// API requests as headers. They are never sent anywhere by default, are never
// written to the server, and can be cleared at any time from Settings. Server
// secrets (PRINTIFY_API_KEY / AI_API_KEY) still work as a fallback when no key
// is saved here.
//
// AI is provider-aware: the user can hold a key per provider and switch the
// active provider/model without losing the others. Fetched model lists are
// cached here too so the picker is instant on reload.

import { getSetting, setSetting } from "@/lib/db/schema";
import {
  DEFAULT_PROVIDER_ID,
  baseUrlFor,
  getProvider,
  normalizeModels,
  type ModelInfo,
} from "@/lib/ai/providers";

export interface AiProviderConfig {
  apiKey: string;
  /** Only used by the `custom` provider (and any manual override). */
  baseUrl?: string;
  /** The model chosen for this provider. */
  model?: string;
}

/**
 * Where the user's integration keys live.
 *
 * The background remover is deliberately NOT here: it runs entirely on this
 * device and needs no key, so there is nothing to configure and nothing to
 * leak.
 */
export interface IntegrationConfig {
  printifyKey: string;
  /** Provider id currently selected. */
  activeProvider: string;
  /** Model id currently selected (mirror of providers[activeProvider].model). */
  activeModel: string;
  providers: Record<string, AiProviderConfig>;
}

export const EMPTY_INTEGRATIONS: IntegrationConfig = {
  printifyKey: "",
  activeProvider: DEFAULT_PROVIDER_ID,
  activeModel: "",
  providers: {},
};

const SETTINGS_KEY = "integrations";

/** Shape written by earlier versions of the app (single AI key/base URL/model). */
interface LegacyIntegrations {
  printifyKey?: string;
  aiKey?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  /** Written by an older version; ignored, the local remover needs no key. */
  bgRemove?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Normalizes whatever is in IndexedDB (new shape or legacy) into the new shape. */
export function migrateIntegrations(stored: Partial<IntegrationConfig> & LegacyIntegrations): IntegrationConfig {
  const config: IntegrationConfig = {
    printifyKey: asString(stored.printifyKey),
    activeProvider: asString(stored.activeProvider) || DEFAULT_PROVIDER_ID,
    activeModel: asString(stored.activeModel),
    providers: {},
  };

  if (stored.providers && typeof stored.providers === "object") {
    for (const [id, value] of Object.entries(stored.providers)) {
      const entry = (value ?? {}) as Partial<AiProviderConfig>;
      config.providers[id] = {
        apiKey: asString(entry.apiKey),
        ...(entry.baseUrl ? { baseUrl: asString(entry.baseUrl) } : {}),
        ...(entry.model ? { model: asString(entry.model) } : {}),
      };
    }
  }

  // Lift a legacy single-key config into the "custom" provider so nothing is lost.
  if (!stored.providers && (stored.aiKey || stored.aiBaseUrl || stored.aiModel)) {
    config.providers.custom = {
      apiKey: asString(stored.aiKey),
      baseUrl: asString(stored.aiBaseUrl),
      model: asString(stored.aiModel),
    };
    config.activeProvider = "custom";
    config.activeModel = asString(stored.aiModel);
  }

  return config;
}

export async function loadIntegrations(): Promise<IntegrationConfig> {
  const stored = await getSetting<Partial<IntegrationConfig> & LegacyIntegrations>(SETTINGS_KEY, {});
  return migrateIntegrations(stored);
}

export async function saveIntegrations(config: IntegrationConfig): Promise<void> {
  await setSetting(SETTINGS_KEY, config);
}

export async function clearIntegrations(): Promise<void> {
  await setSetting(SETTINGS_KEY, EMPTY_INTEGRATIONS);
}

/** The active provider definition, if it is one we know. */
export function activeProvider(config: IntegrationConfig) {
  return getProvider(config.activeProvider);
}

/** The active provider's saved key/config. */
export function activeProviderConfig(config: IntegrationConfig): AiProviderConfig {
  return config.providers[config.activeProvider] ?? { apiKey: "" };
}

/** The effective base URL for the active provider (honours a custom override). */
export function activeBaseUrl(config: IntegrationConfig): string {
  const def = activeProvider(config);
  if (!def) return asString(config.providers.custom?.baseUrl);
  return baseUrlFor(def, activeProviderConfig(config).baseUrl);
}

/** The effective model id for the active provider ("" until one is chosen). */
export function activeModel(config: IntegrationConfig): string {
  const saved = activeProviderConfig(config).model || config.activeModel;
  if (saved.trim()) return saved.trim();
  return activeProvider(config)?.defaultModel ?? "";
}

/** Writes a provider's key/base URL/model and (optionally) makes it active. */
export function patchProvider(
  config: IntegrationConfig,
  id: string,
  patch: Partial<AiProviderConfig>,
): IntegrationConfig {
  const existing = config.providers[id] ?? { apiKey: "" };
  return { ...config, providers: { ...config.providers, [id]: { ...existing, ...patch } } };
}

/** Selects a provider (keeping its saved model, if any). */
export function selectProvider(config: IntegrationConfig, id: string): IntegrationConfig {
  const model = config.providers[id]?.model ?? "";
  return { ...config, activeProvider: id, activeModel: model };
}

/** Selects a model for the active provider. */
export function selectModel(config: IntegrationConfig, modelId: string): IntegrationConfig {
  const next = patchProvider(config, config.activeProvider, { model: modelId });
  return { ...next, activeModel: modelId };
}

/** Builds the credential headers for a fetch request from a config object. */
export function integrationHeaders(config: IntegrationConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const printifyKey = config.printifyKey.trim();
  if (printifyKey) headers["x-printify-key"] = printifyKey;

  const def = activeProvider(config);
  const providerConfig = activeProviderConfig(config);
  const aiKey = providerConfig.apiKey.trim();
  const model = activeModel(config);
  headers["x-ai-provider"] = config.activeProvider;
  if (aiKey) headers["x-ai-key"] = aiKey;
  // Only send a base URL override for providers that don't carry their own.
  const override = providerConfig.baseUrl?.trim();
  if (override && (!def || def.id === "custom")) headers["x-ai-base-url"] = override;
  if (model) headers["x-ai-model"] = model;
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
  const hasProviderKey = Object.values(config.providers).some((p) => p.apiKey.trim());
  return !!(config.printifyKey.trim() || hasProviderKey);
}

// ---------------------------------------------------------------------------
// Model-list cache (per provider) so the picker is instant without a re-fetch.
// ---------------------------------------------------------------------------

export interface ModelCache {
  at: number;
  models: ModelInfo[];
}

export const MODEL_CACHE_TTL = 10 * 60 * 1000;

function modelCacheKey(providerId: string): string {
  return `ai:models:${providerId}`;
}

export async function loadCachedModels(providerId: string): Promise<ModelCache | null> {
  const cache = await getSetting<ModelCache | null>(modelCacheKey(providerId), null);
  if (!cache || !Array.isArray(cache.models)) return null;
  return cache;
}

export async function saveCachedModels(providerId: string, models: ModelInfo[]): Promise<void> {
  await setSetting(modelCacheKey(providerId), { at: Date.now(), models } satisfies ModelCache);
}

/** Re-normalizes a cached list (keeps badges correct if the registry changed). */
export function refreshCachedModels(providerId: string, models: ModelInfo[]): ModelInfo[] {
  const def = getProvider(providerId);
  return def ? normalizeModels(def, models) : models;
}
