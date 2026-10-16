import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { listModels } from "@/lib/server/ai";
import { getProvider } from "@/lib/ai/providers";

// Live model-list fetch for a provider. Proxied through the server so the
// browser never makes a cross-origin call (and CORS/keys stay out of the tab).
// Reads the key from the request headers; the model list itself is read-only and
// nothing is persisted server-side. Some providers (e.g. OpenRouter) expose a
// public model list, so a key is not always required.
export const prerender = false;

interface ModelsRequest {
  provider?: string;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const POST: APIRoute = async ({ request }) => {
  let body: ModelsRequest = {};
  try {
    body = (await request.json()) as ModelsRequest;
  } catch {
    // Body is optional; the provider can also come from the x-ai-provider header.
  }

  const headers = request.headers;
  const providerId = (body.provider ?? clean(headers.get("x-ai-provider")))?.trim();
  if (!providerId) {
    return json({ ok: false, error: "A provider is required." }, 400);
  }

  const def = getProvider(providerId);
  if (!def) {
    return json({ ok: false, error: `Unknown provider "${providerId}".` }, 400);
  }

  const apiKey = clean(headers.get("x-ai-key")) ?? "";
  if (!apiKey && def.auth !== "none" && !def.modelsPublic) {
    return json(
      { ok: false, provider: providerId, configured: false, message: `Paste your ${def.label} API key first.` },
      400,
    );
  }

  const baseUrlOverride = clean(headers.get("x-ai-base-url"));

  try {
    const models = await listModels(providerId, apiKey, baseUrlOverride);
    return json({
      ok: true,
      provider: providerId,
      label: def.label,
      count: models.length,
      free: models.filter((m) => m.free).length,
      models,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        provider: providerId,
        configured: !!apiKey,
        message: error instanceof Error ? error.message : "Could not fetch models.",
      },
      502,
    );
  }
};
