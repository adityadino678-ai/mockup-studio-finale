// ---------------------------------------------------------------------------
// AI provider registry — shared by the browser and the server.
//
// This module is deliberately isomorphic: it holds only public metadata (labels,
// base URLs, endpoints, key hints, docs links) and pure helpers. No secrets and
// no server-only imports, so the Settings UI and the `/api/**` endpoints read
// from the same source of truth.
//
// Every provider we ship speaks the OpenAI-compatible chat completions API, so a
// single server client (lib/server/ai.ts) can serve them all. Providers that are
// not natively OpenAI-compatible (Anthropic, Google) are reached through their
// official OpenAI-compatibility endpoints.
// ---------------------------------------------------------------------------

export type ProviderAuth = "bearer" | "none";

/**
 * How a provider's models are classified as free:
 *  - `pricing`  — read the model's own price (OpenRouter); zero prompt+completion.
 *  - `suffix`   — the model id encodes it (`:free` or `-free`).
 *  - `curated`  — match against an explicit id list on the provider.
 *  - `all`      — every model on this provider is free to use.
 *  - `none`     — no reliable per-model signal; the provider card may still note a
 *                 free tier.
 */
export type FreeMode = "pricing" | "suffix" | "curated" | "all" | "none";

export interface ProviderModelSeed {
  id: string;
  name?: string;
  free?: boolean;
  contextLength?: number;
}

/**
 * Per-model capability hints for the chat composer. `reasoning` decides whether
 * the reasoning/effort pill is shown; `tools` gates function calling; `vision`
 * gates image attachment. All are best-effort heuristics, never guarantees.
 */
export interface ModelCapabilities {
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
}

/**
 * How a provider generates an image.
 *
 * `images` is the OpenAI `POST /images/generations` shape. `chat` is the
 * OpenAI-compatible chat endpoint that returns image parts on the message
 * (OpenRouter and Google's compatibility layer both do this for their image
 * models). There is no third path: a provider without an adapter is not
 * offered in the image picker at all.
 */
export type ImageApi = "images" | "chat";

export interface ImageAdapter {
  api: ImageApi;
  /** Path relative to the provider's base URL. */
  path: string;
  /** Model ids that can generate images on this provider. */
  models: ProviderModelSeed[];
  /** Sizes the provider accepts; the picker only offers these. */
  sizes?: string[];
}

export interface ProviderDef {
  id: string;
  label: string;
  /** One-line description shown under the provider name. */
  blurb: string;
  /** OpenAI-compatible base URL (no trailing slash). Empty for `custom`. */
  baseUrl: string;
  /** Path (relative to baseUrl) returning an OpenAI-style model list. */
  modelsPath: string;
  /** Path (relative to baseUrl) for chat completions. */
  chatPath: string;
  auth: ProviderAuth;
  /** Example value shown as the key input placeholder. */
  keyHint: string;
  docsUrl: string;
  free: FreeMode;
  /** Human note about the provider's free tier, shown as a badge. */
  freeTier?: string;
  /** Explicit free model ids (used when `free === "curated"`). */
  freeModels?: string[];
  /** Model list used when the provider has no `/models` endpoint. */
  fallbackModels?: ProviderModelSeed[];
  /** Known default model, when a provider wants one. */
  defaultModel?: string;
  /** True when the provider is usable with no API key (e.g. a local server). */
  keyOptional?: boolean;
  /** True when the model list is public and can be fetched without a key. */
  modelsPublic?: boolean;
  /** Sort order — lower shows first. */
  priority: number;
  /** Image generation adapter. Absent means the provider cannot make images. */
  image?: ImageAdapter;
}

export interface ModelInfo {
  id: string;
  name: string;
  free: boolean;
  contextLength?: number;
}

export const DEFAULT_PROVIDER_ID = "custom";
export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Model id patterns that are clearly not chat models. */
const NON_CHAT =
  /(embedding|embed\b|whisper|(^|[-_/])tts|audio|speech|rerank|moderation|dall-e|gpt-image|stable-diffusion|(^|[-_/])flux)/i;

export const PROVIDERS: ProviderDef[] = [
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    blurb: "NVIDIA-hosted models via build.nvidia.com (OpenAI-compatible NIM).",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "nvapi-…  (NVIDIA API key)",
    docsUrl: "https://build.nvidia.com/",
    free: "all",
    freeTier: "Free developer tier",
    priority: 2,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key for hundreds of models from many vendors, incl. free ones.",
    baseUrl: "https://openrouter.ai/api/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "sk-or-v1-…  (OpenRouter key)",
    docsUrl: "https://openrouter.ai/keys",
    free: "pricing",
    freeTier: "Free models available",
    modelsPublic: true,
    priority: 3,
    image: {
      api: "chat",
      path: "/chat/completions",
      models: [
        { id: "google/gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image (OpenRouter)" },
      ],
      sizes: ["1024x1024"],
    },
  },
  {
    id: "groq",
    label: "Groq",
    blurb: "Very fast open-model inference on Groq LPUs.",
    baseUrl: "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "gsk_…  (Groq key)",
    docsUrl: "https://console.groq.com/keys",
    free: "all",
    freeTier: "Free tier (rate-limited)",
    priority: 4,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    blurb: "Wafer-scale inference with a free developer tier.",
    baseUrl: "https://api.cerebras.ai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "csk-…  (Cerebras key)",
    docsUrl: "https://cloud.cerebras.ai/",
    free: "all",
    freeTier: "Free tier (rate-limited)",
    priority: 5,
  },
  {
    id: "together",
    label: "Together AI",
    blurb: "Open models hosted by Together, some available free.",
    baseUrl: "https://api.together.xyz/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "…  (Together API key)",
    docsUrl: "https://api.together.ai/settings/api-keys",
    free: "suffix",
    freeTier: "Some models free",
    priority: 6,
    image: {
      api: "images",
      path: "/images/generations",
      models: [
        { id: "black-forest-labs/FLUX.1-schnell", name: "FLUX.1 Schnell" },
        { id: "black-forest-labs/FLUX.1-dev", name: "FLUX.1 Dev" },
      ],
      sizes: ["1024x1024", "1024x1536", "1536x1024"],
    },
  },
  {
    id: "google",
    label: "Google Gemini",
    blurb: "Gemini models through Google's OpenAI-compatible endpoint.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "AIza…  (Google AI Studio key)",
    docsUrl: "https://aistudio.google.com/apikey",
    free: "none",
    freeTier: "Free tier available",
    priority: 7,
    image: {
      // Gemini's OpenAI-compatible layer returns generated pixels on the
      // assistant message, not on /images/generations.
      api: "chat",
      path: "/chat/completions",
      models: [{ id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image" }],
      sizes: ["1024x1024"],
    },
  },
  {
    id: "mistral",
    label: "Mistral",
    blurb: "Mistral's own models via the La Plateforme API.",
    baseUrl: "https://api.mistral.ai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "…  (Mistral API key)",
    docsUrl: "https://console.mistral.ai/api-keys",
    free: "none",
    freeTier: "Free tier available",
    priority: 8,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    blurb: "DeepSeek chat and reasoning models.",
    baseUrl: "https://api.deepseek.com/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "sk-…  (DeepSeek key)",
    docsUrl: "https://platform.deepseek.com/api_keys",
    free: "none",
    priority: 9,
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    blurb: "Fast serverless hosting for open models.",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "fw_…  (Fireworks key)",
    docsUrl: "https://fireworks.ai/account/api-keys",
    free: "none",
    priority: 10,
    image: {
      api: "images",
      path: "/images/generations",
      models: [
        { id: "accounts/fireworks/models/flux-1-schnell", name: "FLUX.1 Schnell (Fireworks)" },
        { id: "accounts/fireworks/models/flux-1-dev", name: "FLUX.1 Dev (Fireworks)" },
      ],
      sizes: ["1024x1024"],
    },
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    blurb: "Grok models from xAI.",
    baseUrl: "https://api.x.ai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "xai-…  (xAI key)",
    docsUrl: "https://console.x.ai/",
    free: "none",
    priority: 11,
    image: {
      api: "images",
      path: "/images/generations",
      models: [
        { id: "grok-2-image", name: "Grok 2 Image" },
        { id: "grok-2-image-1212", name: "Grok 2 Image (1212)" },
      ],
      sizes: ["1024x1024"],
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT models from OpenAI.",
    baseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "sk-…  (OpenAI key)",
    docsUrl: "https://platform.openai.com/api-keys",
    free: "none",
    defaultModel: "gpt-4o-mini",
    priority: 12,
    image: {
      api: "images",
      path: "/images/generations",
      models: [
        { id: "gpt-image-1", name: "GPT Image 1" },
        { id: "dall-e-3", name: "DALL·E 3" },
      ],
      sizes: ["1024x1024", "1024x1536", "1536x1024"],
    },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    blurb: "Claude models via Anthropic's OpenAI-compatibility layer.",
    baseUrl: "https://api.anthropic.com/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "sk-ant-…  (Anthropic key)",
    docsUrl: "https://console.anthropic.com/settings/keys",
    free: "none",
    priority: 13,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    blurb: "Models running on your own machine. No key required.",
    baseUrl: "http://localhost:11434/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "none",
    keyHint: "Not required",
    docsUrl: "https://ollama.com/",
    free: "all",
    freeTier: "Runs locally — free",
    keyOptional: true,
    priority: 14,
  },
  {
    id: "custom",
    label: "Custom / other",
    blurb: "Any other OpenAI-compatible endpoint — set your own base URL.",
    baseUrl: "",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    auth: "bearer",
    keyHint: "Paste any OpenAI-compatible API key",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    free: "none",
    priority: 15,
    image: {
      api: "images",
      path: "/images/generations",
      models: [
        { id: "gpt-image-1", name: "GPT Image 1" },
        { id: "dall-e-3", name: "DALL·E 3" },
      ],
      sizes: ["1024x1024", "1024x1536", "1536x1024"],
    },
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** Providers sorted by priority (the order the UI shows them). */
export function providerList(): ProviderDef[] {
  return [...PROVIDERS].sort((a, b) => a.priority - b.priority);
}

export function getProvider(id: string | null | undefined): ProviderDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Resolves the effective base URL for a provider, honouring a user override. */
export function baseUrlFor(def: ProviderDef, override?: string | null): string {
  const value = override?.trim() || def.baseUrl.trim();
  return value.replace(/\/$/, "");
}

/** Auth headers for a provider, or an empty object when no key is needed. */
export function authHeaders(def: ProviderDef, apiKey: string): Record<string, string> {
  if (def.auth === "none") return {};
  const key = apiKey.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function priceIsZero(value: unknown): boolean {
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return value.trim() !== "" && Number(value) === 0;
  return false;
}

function suffixFree(id: string): boolean {
  return /(:free|-free)$/i.test(id);
}

/** Decides whether a single model is free, using the provider's free mode. */
export function modelFree(def: ProviderDef, id: string, entry?: Record<string, unknown>): boolean {
  switch (def.free) {
    case "all":
      return true;
    case "suffix":
      return suffixFree(id);
    case "curated":
      return (def.freeModels ?? []).some(
        (m) => id === m || id.startsWith(`${m}:`) || id.startsWith(`${m}/`),
      );
    case "pricing": {
      const pricing = (entry?.pricing ?? {}) as Record<string, unknown>;
      if (priceIsZero(pricing.prompt) && priceIsZero(pricing.completion)) return true;
      return suffixFree(id);
    }
    default:
      return false;
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Normalizes a provider's model-list response into a clean, chat-only, deduped
 * list with free tags applied. Accepts either `{ data: [...] }` (OpenAI style)
 * or a bare array. Rows that are obviously not chat models are dropped.
 */
export function normalizeModels(def: ProviderDef, raw: unknown): ModelInfo[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown[] } | null)?.data)
      ? ((raw as { data: unknown[] }).data)
      : [];

  const out = new Map<string, ModelInfo>();
  for (const row of rows) {
    const entry = (row ?? {}) as Record<string, unknown>;
    const id = String(entry.id ?? entry.name ?? "").trim();
    if (!id || NON_CHAT.test(id)) continue;
    const name = String(entry.name ?? id).trim() || id;
    const contextLength = toNumber(
      entry.context_length ?? entry.context_window ?? entry.max_context_length ?? entry.context,
    );
    const free = entry.free === true || modelFree(def, id, entry);
    if (!out.has(id)) out.set(id, { id, name, free, contextLength });
  }

  return [...out.values()].sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Capability hints
//
// Tools (function calling) and vision are provider-wide flags — the composer
// only offers them where the provider broadly supports them. Reasoning effort is
// model-specific, so it is matched against the model id.
// ---------------------------------------------------------------------------

const PROVIDER_CAPS: Record<string, { tools?: boolean; vision?: boolean }> = {
  nvidia: { tools: true, vision: true },
  openrouter: { tools: true, vision: true },
  groq: { tools: true },
  cerebras: { tools: true },
  together: { tools: true, vision: true },
  google: { tools: true, vision: true },
  mistral: { tools: true, vision: true },
  deepseek: { tools: true },
  fireworks: { tools: true },
  xai: { tools: true, vision: true },
  openai: { tools: true, vision: true },
  anthropic: { tools: true, vision: true },
  ollama: { tools: true, vision: true },
  custom: { tools: true, vision: true },
};

const REASONING_MODEL =
  /(^|[-_/])(o1|o3|o4|gpt-5|reasoner|reasoning|thinking|think|qwq|deepseek-r|r1|glm-z|magistral)([-_/]|$)/i;

/** Whether a model id looks like a reasoning model that accepts an effort hint. */
export function modelReasoning(modelId: string): boolean {
  const id = (modelId || "").toLowerCase();
  if (!id) return false;
  if (/:thinking\b/.test(id)) return true;
  return REASONING_MODEL.test(id);
}

/** Best-effort capabilities for a provider + model id. */
export function modelCapabilities(providerId: string, modelId: string): ModelCapabilities {
  const caps = PROVIDER_CAPS[providerId] ?? {};
  return {
    reasoning: modelReasoning(modelId),
    tools: !!caps.tools,
    vision: !!caps.vision,
  };
}

// ---------------------------------------------------------------------------
// Model-kind filtering
//
// The provider-wide flags above answer "can this provider do vision at all".
// The agent needs the narrower question "can THIS model see an image", because
// picking a text-only model silently produces a description invented from the
// design's name. The rules below are model-id heuristics: a model has to look
// like a vision model AND come from a provider that supports image input.
// Anything we cannot recognise is excluded rather than guessed at.
// ---------------------------------------------------------------------------

/** Model ids that are clearly not vision chat models. */
const NON_VISION_MODEL =
  /(embed|embedding|whisper|(^|[-_/])tts|audio|speech|rerank|moderation|dall-e|gpt-image|diffusion|stable-diffusion|(^|[-_/])flux)/i;

/** Model ids that are known to accept image input. */
const VISION_MODEL =
  /(vision|llava|pixtral|internvl|molmo|idefics|(^|[-_/])vl([-_/]|$)|[-_]vl[-_]|(^|[-_/])(gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|o3|o4-mini|gemini|claude|grok-[2-9]|qwen[0-9.]*-vl|nemotron[^ ]*vl))/i;

/** True when the model is one of a provider's image-generation models. */
export function isImageModel(providerId: string, modelId: string): boolean {
  const def = getProvider(providerId);
  const id = (modelId ?? "").trim().toLowerCase();
  if (!def?.image || !id) return false;
  return def.image.models.some((m) => {
    const want = m.id.toLowerCase();
    return id === want || id.startsWith(`${want}:`) || id.startsWith(`${want}-`);
  });
}

/**
 * True when this exact model can be handed a design image.
 *
 * Deliberately conservative. A provider that admits a text-only model cannot
 * be proven safe by a registry flag, so the id has to carry a vision hint too.
 */
export function isVisionModel(providerId: string, modelId: string): boolean {
  const caps = PROVIDER_CAPS[providerId] ?? {};
  const id = (modelId ?? "").trim().toLowerCase();
  if (!caps.vision || !id) return false;
  if (NON_VISION_MODEL.test(id)) return false;
  if (isImageModel(providerId, id)) return false;
  return VISION_MODEL.test(id);
}

/** Providers that can generate images, in picker order. */
export function imageProviders(): ProviderDef[] {
  return providerList().filter((p) => !!p.image);
}

/** The image models a provider offers. */
export function imageModelsFor(providerId: string): ProviderModelSeed[] {
  return getProvider(providerId)?.image?.models ?? [];
}

/**
 * Filters a provider's live model list for the picker's `kind`.
 *
 * - `vision`: chat models with image input (the Listing-agent picker).
 * - `image`: that provider's image-generation models.
 * - `chat`: every chat model (Settings' connection tests).
 */
export function filterModels(
  providerId: string,
  models: ModelInfo[],
  kind: "chat" | "vision" | "image",
): ModelInfo[] {
  if (kind === "chat") return models;
  if (kind === "vision") return models.filter((m) => isVisionModel(providerId, m.id));
  const seeds = imageModelsFor(providerId);
  const out: ModelInfo[] = [];
  for (const seed of seeds) {
    const live = models.find((m) => m.id === seed.id);
    out.push(live ?? { id: seed.id, name: seed.name ?? seed.id, free: false });
  }
  return out;
}

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Favourites are stored as `provider/model` keys. */
export function favoriteKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}
