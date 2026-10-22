"use client";

// ---------------------------------------------------------------------------
// Background removal through a hosted API.
//
// The local engines are free, private and instant, but they are also limited:
// the flood key needs one flat colour, the border model needs a backdrop that
// fades, and the local segmenter needs a ~25 MB model download. A hosted
// service removes those limits, and the user can bring their own key for it.
//
// The key never leaves this origin except as a request header on our own
// endpoint, which forwards it to the provider. Nothing is stored on the
// server.
//
// The providers:
//
//   remove-bg   - a dedicated background-removal service. Its own key.
//   photoroom   - the same, with a different request shape. Its own key.
//   gemini      - Google AI Studio. It SEPARATES the subject by editing the
//                 image, and reuses the Google key the app already holds as
//                 the `google` AI provider, so it needs no second key.
// ---------------------------------------------------------------------------

import { artworkToBase64Sized } from "@/lib/client/artwork";
import {
  bgRemoveHeaders,
  loadIntegrations,
  type BgRemoveProvider,
} from "@/lib/client/integrations";

export type { BgRemoveProvider };

export interface BgApiOutcome {
  blob: Blob;
  /** The provider that did the work. */
  provider: BgRemoveProvider;
  /** Fraction of pixels whose alpha CHANGED. */
  removed: number;
}

/** The endpoint that forwards to the provider. */
const ENDPOINT = "/api/bg-remove";

/**
 * The largest image we send.
 *
 * Base64 inflates by about a third, and the Workers memory ceiling is
 * 128 MB, so the payload is kept well under the providers' own limits.
 */
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

/** The long edge we send. The original is kept when it already fits. */
const MAX_LONG_EDGE = 8000;

/**
 * The fraction of pixels whose alpha changed.
 *
 * The same measure the local engines report, so the UI can say the same
 * thing whichever engine ran.
 */
async function alphaChangeFraction(before: Blob, after: Blob): Promise<number> {
  const read = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const a = await read(before);
  const b = await read(after);
  if (!a || !b) return 0;
  const pixels = Math.min(a.length, b.length);
  if (pixels === 0) return 0;
  let changed = 0;
  let count = 0;
  for (let i = 3; i < pixels; i += 4) {
    count++;
    if (a[i] !== b[i]) changed++;
  }
  return count > 0 ? changed / count : 0;
}

/**
 * Removes a background through the user's own hosted service.
 *
 * Throws an `Error` whose message is safe to show a user.
 */
export async function removeBackgroundWithApi(
  blob: Blob,
  opts: {
    provider: BgRemoveProvider;
    onProgress?: (stage: string) => void;
  },
): Promise<BgApiOutcome> {
  const config = await loadIntegrations();
  const provider = opts.provider;
  opts.onProgress?.("Sending the image to the background remover…");

  const base64 = await artworkToBase64Sized(blob, MAX_LONG_EDGE, MAX_UPLOAD_BYTES);

  const headers = new Headers(bgRemoveHeaders(config));
  headers.set("Content-Type", "application/json");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ image: base64, mimeType: "image/png" }),
  });

  if (!response.ok) {
    const message = await readError(response);
    throw new Error(message);
  }

  const cutout = await response.blob();
  if (!cutout.size) {
    throw new Error("The background remover returned an empty image.");
  }
  const used = (response.headers.get("x-bg-remove-engine") ?? provider) as BgRemoveProvider;

  opts.onProgress?.("Done");
  return {
    blob: cutout,
    provider: used,
    removed: await alphaChangeFraction(blob, cutout),
  };
}

/** Reads an error message out of a failed response, safely. */
async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `The background remover failed (${response.status}).`;
    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (typeof data.error === "string" && data.error.trim()) {
        return data.error.trim().slice(0, 300);
      }
    } catch {
      // Not JSON - fall through to the raw text.
    }
    // A provider's own error text is usually useful, but it can be long and
    // it can echo the key back, so it is trimmed and kept short.
    return text.replace(/[A-Za-z0-9_-]{24,}/g, "…").slice(0, 300);
  } catch {
    return `The background remover failed (${response.status}).`;
  }
}
