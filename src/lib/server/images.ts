// ---------------------------------------------------------------------------
// Server-side image generation.
//
// One prompt in, one image out. Two adapters exist and that is deliberate:
// `images` is the OpenAI `/images/generations` shape, `chat` is the
// OpenAI-compatible chat endpoint that returns pixels on the assistant message
// (OpenRouter and Google's compatibility layer). A provider with no adapter is
// never offered in the image picker, so this module refuses rather than
// guessing an endpoint.
//
// The image is returned as a data URL. Remote URLs are fetched here so the
// browser never has to make a cross-origin request just to save the result.
// ---------------------------------------------------------------------------

import { aiConfig } from "@/lib/server/ai";
import { authHeaders, getProvider, type ImageAdapter } from "@/lib/ai/providers";
import type { AiCredentials } from "@/lib/server/creds";

export interface GeneratedImage {
  dataUrl: string;
  mime: string;
  revisedPrompt?: string;
}

export class ImageNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageNotConfiguredError";
  }
}

interface ImageRequest {
  prompt: string;
  /** Explicit model id from the client's image picker. */
  model?: string;
  size?: string;
  creds?: AiCredentials;
  signal?: AbortSignal;
}

function adapterFor(provider: string): { adapter: ImageAdapter; baseUrl: string; apiKey: string } {
  const def = getProvider(provider);
  const adapter = def?.image;
  if (!def || !adapter) {
    throw new ImageNotConfiguredError(
      `“${provider}” has no image generation adapter. Choose an image model from a provider that does.`,
    );
  }
  return { adapter, baseUrl: def.baseUrl, apiKey: "" };
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const data = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: unknown;
      detail?: unknown;
    };
    const error = data?.error;
    const message =
      (typeof error === "string" ? error : error?.message) ??
      (typeof data?.message === "string" ? data.message : undefined) ??
      (typeof data?.detail === "string" ? data.detail : undefined);
    if (message) return message;
  } catch {
    /* fall through */
  }
  const raw = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return raw ? `Image generation failed with HTTP ${res.status}: ${raw}` : `Image generation failed with HTTP ${res.status}`;
}

/** Turns a remote URL into a data URL so the result is self-contained. */
async function urlToDataUrl(url: string, signal?: AbortSignal): Promise<GeneratedImage> {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)[^,]*,(.*)$/s.exec(url);
    return {
      dataUrl: url,
      mime: match?.[1] ?? "image/png",
    };
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Could not download the generated image (HTTP ${res.status}).`);
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { dataUrl: `data:${mime};base64,${btoa(binary)}`, mime };
}

function readImagePart(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.b64_json === "string" && row.b64_json) return `data:image/png;base64,${row.b64_json}`;
  if (typeof row.url === "string" && row.url) return row.url;
  const imageUrl = row.image_url;
  if (typeof imageUrl === "string") return imageUrl;
  if (imageUrl && typeof imageUrl === "object") {
    const nested = (imageUrl as Record<string, unknown>).url;
    if (typeof nested === "string") return nested;
  }
  if (row.type === "image_url" && typeof row.image_url === "string") return row.image_url;
  return undefined;
}

/** Pulls the first image out of either adapter's response shape. */
function extractImage(payload: unknown): { url?: string; revisedPrompt?: string } {
  const data = payload as Record<string, unknown> | null;
  const rows = (data?.data ?? data?.images) as unknown;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const url = readImagePart(row);
      if (url) {
        const revised =
          row && typeof row === "object" && typeof (row as Record<string, unknown>).revised_prompt === "string"
            ? String((row as Record<string, unknown>).revised_prompt)
            : undefined;
        return { url, revisedPrompt: revised };
      }
    }
  }
  const choices = data?.choices as unknown;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const message = (choice as { message?: Record<string, unknown> })?.message;
      if (!message) continue;
      const images = message.images;
      if (Array.isArray(images)) {
        for (const image of images) {
          const url = readImagePart(image);
          if (url) return { url };
        }
      }
      const content = message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const url = readImagePart(part);
          if (url) return { url };
        }
      }
    }
  }
  return {};
}

async function generateViaImages(
  def: ReturnType<typeof getProvider>,
  adapter: ImageAdapter,
  baseUrl: string,
  apiKey: string,
  input: ImageRequest,
  model: string,
): Promise<GeneratedImage> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(def!, apiKey),
  };
  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    n: 1,
  };
  if (input.size) body.size = input.size;
  // Most providers accept b64_json; some only return URLs and reject the field.
  body.response_format = "b64_json";

  let res = await fetch(`${baseUrl}${adapter.path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: input.signal,
  });
  if (!res.ok) {
    const first = await errorText(res);
    if (/response_format|b64_json/i.test(first)) {
      delete body.response_format;
      res = await fetch(`${baseUrl}${adapter.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: input.signal,
      });
      if (!res.ok) throw new Error(await errorText(res));
    } else {
      throw new Error(first);
    }
  }
  const payload = await res.json().catch(() => null);
  const { url, revisedPrompt } = extractImage(payload);
  if (!url) throw new Error("The provider returned no image.");
  const generated = await urlToDataUrl(url, input.signal);
  return { ...generated, revisedPrompt };
}

async function generateViaChat(
  def: ReturnType<typeof getProvider>,
  adapter: ImageAdapter,
  baseUrl: string,
  apiKey: string,
  input: ImageRequest,
  model: string,
): Promise<GeneratedImage> {
  const res = await fetch(`${baseUrl}${adapter.path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(def!, apiKey),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: input.prompt }],
      modalities: ["image", "text"],
    }),
    signal: input.signal,
  });
  if (!res.ok) throw new Error(await errorText(res));
  const payload = await res.json().catch(() => null);
  const { url } = extractImage(payload);
  if (!url) throw new Error("The provider returned no image.");
  return urlToDataUrl(url, input.signal);
}

/**
 * Generates one image with the provider the request is authenticated for.
 *
 * Throws `ImageNotConfiguredError` when no provider/key is configured, and a
 * plain Error carrying the upstream message when the provider refuses.
 */
export async function generateImage(input: ImageRequest): Promise<GeneratedImage> {
  const config = aiConfig(input.creds);
  if (!config.configured) {
    throw new ImageNotConfiguredError(
      "Image generation needs an AI provider key. Paste one in Settings, then pick an image model in the Studio agent.",
    );
  }
  const provider = input.creds?.provider ?? config.provider;
  const { adapter } = adapterFor(provider);
  const def = getProvider(provider)!;
  const baseUrl = input.creds?.baseUrl || def.baseUrl;
  const apiKey = input.creds?.apiKey ?? "";
  const model = input.model?.trim() || adapter.models[0]?.id;
  if (!model) {
    throw new ImageNotConfiguredError(`“${provider}” exposes no image models.`);
  }
  const size = input.size && adapter.sizes?.includes(input.size) ? input.size : adapter.sizes?.[0];
  const request = { ...input, size };

  return adapter.api === "chat"
    ? generateViaChat(def, adapter, baseUrl, apiKey, request, model)
    : generateViaImages(def, adapter, baseUrl, apiKey, request, model);
}
