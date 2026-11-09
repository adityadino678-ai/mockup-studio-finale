import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { listModels } from "@/lib/server/ai";
import { filterModels, getProvider } from "@/lib/ai/providers";
import { validateBody } from "@/lib/security/validation";

// Live model-list fetch for a provider. Proxied through the server so the
// browser never makes a cross-origin call (and CORS/keys stay out of the tab).
// Reads the key from the request headers; the model list itself is read-only and
// nothing is persisted server-side. Some providers (e.g. OpenRouter) expose a
// public model list, so a key is not always required.
export const prerender = false;

interface ModelsRequest {
  provider?: string;
  kind?: "chat" | "vision" | "image";
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  let body: ModelsRequest = {};
  try {
    body = (await request.json()) as ModelsRequest;
  } catch {
    // Body is optional; the provider can also come from the x-ai-provider header.
  }

  const validation = validateBody("POST /api/integrations/models", body);
  if (!validation.success) {
    return json({ error: validation.error }, 400);
  }
  body = validation.data as ModelsRequest;

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
  const kind = body.kind ?? "chat";

  // Image models are a curated per-provider list, not the provider's chat
  // catalogue: /models is a chat list and would never contain them.
  if (kind === "image") {
    const models = filterModels(def.id, [], "image");
    return json({
      ok: true,
      provider: providerId,
      label: def.label,
      kind,
      count: models.length,
      free: 0,
      models,
    });
  }

  if (!apiKey && def.auth !== "none" && !def.modelsPublic) {
    return json(
      { ok: false, provider: providerId, configured: false, message: `Paste your ${def.label} API key first.` },
      400,
    );
  }

  const baseUrlOverride = clean(headers.get("x-ai-base-url"));

  try {
    const models = filterModels(providerId, await listModels(providerId, apiKey, baseUrlOverride), kind);
    return json({
      ok: true,
      provider: providerId,
      label: def.label,
      kind,
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
