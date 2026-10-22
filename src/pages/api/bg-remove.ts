// Hosted background-removal endpoint.
//
// The visitor can run background removal through their own key instead of the
// bundled local engines (flood-key / border-model / ai-segmenter). The key is
// sent as a request header, resolved here, and forwarded to the provider —
// it is never stored on the server.
//
// Three providers are supported:
//   remove-bg   https://api.remove.bg      (dedicated cutout API, own key)
//   photoroom   https://api.photoroom.com  (dedicated cutout API, own key)
//   gemini      Google AI Studio           (reuses the AI key from Settings)
//
// The request shapes are built by pure functions so they can be unit tested
// without touching the network.

import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest, parseBgRemoveProvider, type BgRemoveProvider } from "@/lib/server/creds";

export const prerender = false;

/** A provider call, ready to hand to `fetch`. Built by the pure functions below. */
export interface ProviderRequest {
  url: string;
  init: RequestInit;
}

export const REMOVE_BG_URL = "https://api.remove.bg/v1.0/removebg";
export const PHOTOROOM_URL = "https://api.photoroom.com/v1/remove-background";
export const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** Gemini's image model. It returns a PNG with an alpha channel. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-image";

/** Response header naming the provider that actually did the work. */
export const ENGINE_HEADER = "x-bg-remove-engine";

/**
 * Ceiling for the whole request body.
 *
 * The body carries a base64 image, and base64 inflates by about a third, so a
 * 12 MB body decodes to roughly 9 MB of pixels. That is comfortably inside the
 * 128 MB Workers memory ceiling; anything larger would risk the Worker being
 * killed mid-request, which looks like a random 500 to the user.
 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

/** Longest provider error text we show the user. */
const MAX_ERROR_LENGTH = 300;

const GEMINI_PROMPT =
  "Remove the background from this image. Return only the subject on a fully transparent background, keeping its edges and colours exactly as they are.";

/** Human labels, used in error messages. */
const PROVIDER_LABELS: Record<BgRemoveProvider, string> = {
  "remove-bg": "remove.bg",
  photoroom: "PhotoRoom",
  gemini: "Google AI Studio",
};

// --- provider request shapes (pure) ----------------------------------------

/**
 * remove.bg — form encoded, the image goes in as `image_file`.
 *
 * The base64 is url-encoded by `URLSearchParams`, which matters: a raw base64
 * string contains `+` and `/`, and an unencoded `+` would arrive as a space.
 */
export function buildRemoveBgRequest(base64: string, key: string): ProviderRequest {
  return {
    url: REMOVE_BG_URL,
    init: {
      method: "POST",
      headers: {
        "X-Api-Key": key,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ image_file: base64 }).toString(),
    },
  };
}

/** PhotoRoom — JSON, the image goes in as `image_file`. */
export function buildPhotoRoomRequest(base64: string, key: string): ProviderRequest {
  return {
    url: PHOTOROOM_URL,
    init: {
      method: "POST",
      headers: {
        "x-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_file: base64 }),
    },
  };
}

/**
 * Gemini — Google AI Studio edits the image so the background is transparent.
 *
 * The key travels as a query parameter because that is the only auth the
 * Generative Language API accepts. The model id is url-encoded here; it is
 * additionally validated before it ever reaches this function.
 */
export function buildGeminiRequest(
  base64: string,
  key: string,
  mimeType: string,
  model: string = DEFAULT_GEMINI_MODEL,
): ProviderRequest {
  return {
    url: `${GEMINI_MODELS_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              { text: GEMINI_PROMPT },
            ],
          },
        ],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    },
  };
}

// --- helpers ---------------------------------------------------------------

/** Strips an optional `data:` prefix so a prefixed payload still works. */
function stripDataPrefix(value: string): string {
  if (!value.startsWith("data:")) return value;
  const comma = value.indexOf(",");
  return comma >= 0 ? value.slice(comma + 1) : value;
}

/**
 * Decodes base64 into bytes.
 *
 * `Buffer` does not exist in the Workers runtime, so `atob` plus a
 * `Uint8Array` is the portable way to turn base64 into a body. The buffer is
 * allocated explicitly so the result is a plain `ArrayBuffer`-backed view,
 * which is what a `Response` body accepts.
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Makes a provider's own error text safe to show.
 *
 * The key is removed first, then anything that looks like a long opaque token
 * (a provider echoing the key back, or a session id) is redacted as well, and
 * the result is truncated. We never want a credential in the UI, and an
 * unbounded provider message would wreck the layout.
 */
export function sanitizeProviderMessage(raw: string, key: string): string {
  let text = raw ?? "";
  if (key) text = text.split(key).join("[redacted]");
  text = text.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "The provider did not explain the failure.";
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/**
 * Digs the useful message out of a provider's JSON error body.
 *
 * remove.bg answers `{"error": "..."}`, PhotoRoom answers
 * `{"error": {"message": "..."}}` and Google answers
 * `{"error": {"message": "..."}}`, so every known shape is checked.
 */
export function pickProviderMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data.trim() || undefined;
  if (!data || typeof data !== "object") return undefined;
  const root = data as Record<string, unknown>;
  const candidates: unknown[] = [];
  const error = root.error;
  if (typeof error === "string") {
    candidates.push(error);
  } else if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    candidates.push(obj.message, obj.detail, obj.errors);
  }
  candidates.push(root.message, root.detail, root.errors);
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate)) {
      const first = candidate.find((item) => typeof item === "string" && item.trim());
      if (typeof first === "string") return first.trim();
      const withMessage = candidate.find(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof (item as { message?: unknown }).message === "string" &&
          ((item as { message?: string }).message ?? "").trim(),
      );
      if (withMessage) return (withMessage as { message: string }).message.trim();
    }
    if (candidate && typeof candidate === "object") {
      const message = (candidate as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  return undefined;
}

/** The Gemini response shape we consume (a small subset). */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<Record<string, unknown>> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/** Finds the first inline image in a Gemini answer. */
export function extractGeminiImage(data: unknown): string | undefined {
  const root = data as GeminiResponse | undefined;
  const candidates = root?.candidates;
  if (!Array.isArray(candidates)) return undefined;
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = part.inlineData as { data?: unknown } | undefined;
      const snake = part.inline_data as { data?: unknown } | undefined;
      const encoded = inline?.data ?? snake?.data;
      if (typeof encoded === "string" && encoded.trim()) return encoded.trim();
    }
  }
  return undefined;
}

/**
 * Collects the text Gemini answered with.
 *
 * The image model sometimes replies with words instead of an image (a refusal,
 * or a description of what it did). That text is the most useful thing we can
 * show the user, so it is surfaced instead of a generic failure.
 */
export function extractGeminiText(data: unknown): string | undefined {
  const root = data as GeminiResponse | undefined;
  const chunks: string[] = [];
  for (const candidate of root?.candidates ?? []) {
    for (const part of candidate?.content?.parts ?? []) {
      const text = part.text;
      if (typeof text === "string" && text.trim()) chunks.push(text.trim());
    }
  }
  const blockReason = root?.promptFeedback?.blockReason;
  if (blockReason) chunks.push(`Blocked by the model (${blockReason}).`);
  return chunks.length ? chunks.join(" ") : undefined;
}

/** Parses JSON, falling back to the raw text when it is not JSON. */
function parseJsonText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Decodes bytes as UTF-8 text (for a provider that answered with prose). */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/**
 * True when the bytes start with the PNG signature.
 *
 * Some gateways serve an image as `application/octet-stream`, so the content
 * type alone cannot be trusted to say whether the body is an image.
 */
export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  );
}

/** The message shown when the chosen provider has no key at all. */
export function missingKeyMessage(provider: BgRemoveProvider): string {
  return provider === "gemini"
    ? "No Google AI Studio key is configured. Add one in Settings under AI providers."
    : "No background-removal key is configured. Add one in Settings, or use the local engines.";
}

/** Maps a provider status onto a status we are willing to show the client. */
function clientStatus(status: number): number {
  if (status === 429) return 429;
  if (status >= 400 && status < 500) return 400;
  return 502;
}

/** Builds the successful PNG response. */
function pngResponse(bytes: Uint8Array<ArrayBuffer>, engine: BgRemoveProvider): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // The answer depends on the caller's credential, so it must not be cached.
      "Cache-Control": "no-store",
      [ENGINE_HEADER]: engine,
    },
  });
}

interface BgRemoveBody {
  image?: unknown;
  mimeType?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
  // The provider is read from the header (and validated) twice — once here
  // for the error message, once inside `credentialsFromRequest` for the key.
  // Both use the same helper, so they always agree.
  const provider =
    parseBgRemoveProvider(request.headers.get("x-bg-remove-provider")) ?? "remove-bg";

  const creds = credentialsFromRequest(request);
  const bg = creds.bgRemove;
  if (!bg) {
    return json({ error: missingKeyMessage(provider) }, 503);
  }
  const engine = bg.provider;
  const key = bg.apiKey;

  // --- body ----------------------------------------------------------------
  // The declared length is checked first so an oversized upload is refused
  // before it is buffered.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json(
      {
        error:
          "That image is too large for the hosted background remover (12 MB limit). Use a smaller image, or the local engines.",
      },
      413,
    );
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Could not read the request body" }, 400);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return json(
      {
        error:
          "That image is too large for the hosted background remover (12 MB limit). Use a smaller image, or the local engines.",
      },
      413,
    );
  }

  let body: BgRemoveBody;
  try {
    body = JSON.parse(raw) as BgRemoveBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.image !== "string" || !body.image.trim()) {
    return json({ error: "An image is required" }, 400);
  }
  const base64 = stripDataPrefix(body.image.trim());

  const mimeType =
    typeof body.mimeType === "string" && body.mimeType.trim() ? body.mimeType.trim() : "image/png";
  if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    return json({ error: `Unsupported image type: ${mimeType}` }, 400);
  }

  // The model id is interpolated into a URL, so it is restricted to the
  // characters a model name can contain.
  const model =
    request.headers.get("x-bg-remove-model")?.trim() || DEFAULT_GEMINI_MODEL;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(model)) {
    return json({ error: "Invalid model name" }, 400);
  }

  // --- provider call -------------------------------------------------------
  const shape =
    engine === "gemini"
      ? buildGeminiRequest(base64, key, mimeType, model)
      : engine === "photoroom"
        ? buildPhotoRoomRequest(base64, key)
        : buildRemoveBgRequest(base64, key);

  let res: Response;
  try {
    res = await fetch(shape.url, {
      ...shape.init,
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return json(
      { error: `Could not reach ${PROVIDER_LABELS[engine]}. Check the connection and try again.` },
      502,
    );
  }

  // --- Gemini --------------------------------------------------------------
  // Gemini answers with JSON, never with an image body: the PNG is base64
  // inside the first candidate's inline data.
  if (engine === "gemini") {
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message =
        pickProviderMessage(data) ?? providerStatusMessage("gemini", res.status);
      return json({ error: sanitizeProviderMessage(message, key) }, clientStatus(res.status));
    }
    const encoded = extractGeminiImage(data);
    if (!encoded) {
      const said = extractGeminiText(data);
      return json(
        {
          error: sanitizeProviderMessage(
            said ?? "Google AI Studio returned no image. Try a different model or the local engines.",
            key,
          ),
        },
        502,
      );
    }
    try {
      return pngResponse(base64ToBytes(encoded), engine);
    } catch {
      return json({ error: "Google AI Studio returned an image that could not be decoded." }, 502);
    }
  }

  // --- remove.bg / PhotoRoom ----------------------------------------------
  // Both answer with the PNG itself on success. remove.bg answers with JSON on
  // failure, so a body that is not an image is read as JSON and its message is
  // surfaced.
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

  if (res.ok && contentType.includes("json")) {
    // A 200 with a JSON body is the provider reporting a problem.
    const data = parseJsonText(await res.text().catch(() => ""));
    const message =
      pickProviderMessage(data) ?? `${PROVIDER_LABELS[engine]} answered with an error instead of an image.`;
    return json({ error: sanitizeProviderMessage(message, key) }, 502);
  }

  if (res.ok) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (contentType.startsWith("image/") || isPng(bytes)) {
      return pngResponse(bytes, engine);
    }
    // Neither an image nor a PNG - the body is the provider's explanation.
    const data = parseJsonText(decodeText(bytes));
    const message =
      pickProviderMessage(data) ?? `${PROVIDER_LABELS[engine]} did not return an image.`;
    return json({ error: sanitizeProviderMessage(message, key) }, 502);
  }

  const data = parseJsonText(await res.text().catch(() => ""));
  const message =
    pickProviderMessage(data) ?? providerStatusMessage(engine, res.status);
  return json({ error: sanitizeProviderMessage(message, key) }, clientStatus(res.status));
};

/**
 * What to say when a provider answered with a status and no explanation.
 *
 * A rejected key is by far the most common real failure, and "answered HTTP
 * 403" does not tell the user what to do about it.
 */
export function providerStatusMessage(engine: BgRemoveProvider, status: number): string {
  if (status === 401 || status === 403) {
    return `${PROVIDER_LABELS[engine]} rejected the API key. Check the key in Settings.`;
  }
  if (status === 429) {
    return `${PROVIDER_LABELS[engine]} is rate-limiting this key. Try again in a moment.`;
  }
  if (status === 413) {
    return `${PROVIDER_LABELS[engine]} says the image is too large. Use a smaller image.`;
  }
  return `${PROVIDER_LABELS[engine]} answered HTTP ${status}.`;
}

/** A GET is handy for smoke-testing that the route is live. */
export const GET: APIRoute = async () => {
  return json(
    {
      ok: true,
      endpoint: "bg-remove",
      providers: ["remove-bg", "photoroom", "gemini"],
      defaultModel: DEFAULT_GEMINI_MODEL,
    },
    200,
  );
};
