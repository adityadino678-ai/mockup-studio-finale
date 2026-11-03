import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { generateImage, ImageNotConfiguredError } from "@/lib/server/images";
import { credentialsFromRequest } from "@/lib/server/creds";
import { validateBody } from "@/lib/security/validation";

export const prerender = false;

interface ImagesRequest {
  prompt?: string;
  model?: string;
  size?: string;
}

export const POST: APIRoute = async ({ request }) => {
  const creds = credentialsFromRequest(request);
  if (!creds.ai) {
    return json(
      {
        configured: false,
        error:
          "Image generation needs an AI provider key. Paste one in Settings, then pick an image model.",
      },
      503,
    );
  }

  const validation = validateBody("POST /api/ai/images", await request.json());
  if (!validation.success) {
    return json({ error: validation.error }, 400);
  }
  const body = validation.data as unknown as ImagesRequest;
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return json({ error: "A prompt is required" }, 400);

  try {
    const image = await generateImage({
      prompt,
      model: body.model,
      size: body.size,
      creds: creds.ai,
      signal: request.signal,
    });
    return json(
      {
        configured: true,
        image: image.dataUrl,
        mime: image.mime,
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      },
      200,
    );
  } catch (error) {
    if (error instanceof ImageNotConfiguredError) {
      return json({ configured: false, error: error.message }, 503);
    }
    return json(
      { error: error instanceof Error ? error.message : "Image generation failed." },
      502,
    );
  }
};

// Read-only probe, same convention as the other AI endpoints.
export const GET: APIRoute = async () => {
  return json({ ok: true, endpoint: "ai/images" }, 200);
};
