"use client";

// ---------------------------------------------------------------------------
// Image generation from the browser.
//
// The call goes to `/api/ai/images`, which holds the provider key handling
// and the two adapter shapes (the OpenAI images endpoint and the chat
// endpoint that returns pixels on the message). The browser only sends the
// prompt and the chosen model.
// ---------------------------------------------------------------------------

import { authedFetch } from "@/lib/client/integrations";

export interface GeneratedImage {
  dataUrl: string;
  mime: string;
  revisedPrompt?: string;
}

/**
 * Generates one image with the given model.
 *
 * The provider id is sent as a header so the server knows which adapter and
 * which base URL to use; the key rides along in the usual integration
 * headers.
 */
export async function generateImage(
  prompt: string,
  model: string,
  provider: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const res = await authedFetch("/api/ai/images", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-provider": provider,
      ...(model ? { "x-ai-model": model } : {}),
    },
    body: JSON.stringify({ prompt, model }),
    signal,
  });

  let payload: { image?: string; mime?: string; revisedPrompt?: string; error?: string } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    /* keep the default */
  }
  if (!res.ok) {
    throw new Error(payload.error ?? `The image provider returned HTTP ${res.status}.`);
  }
  if (!payload.image) {
    throw new Error("The provider returned no image.");
  }
  return {
    dataUrl: payload.image,
    mime: payload.mime ?? "image/png",
    revisedPrompt: payload.revisedPrompt,
  };
}
