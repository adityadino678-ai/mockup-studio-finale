import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import {
  createPrintifyClient,
  PrintifyError,
  type PrintifyBlueprintDetail,
} from "@/lib/server/printify";

function fail(error: unknown) {
  if (error instanceof PrintifyError) {
    return json(
      { error: error.message, status: error.status },
      { status: error.status === 501 ? 503 : 502 },
    );
  }
  return json(
    { error: error instanceof Error ? error.message : "Unexpected Printify error" },
    500,
  );
}

/**
 * GET /api/printify/catalog?category=...            -> blueprint list
 * GET /api/printify/catalog?id=123                 -> blueprint detail (variants + print areas)
 * GET /api/printify/catalog?id=123&providers=1     -> print providers for a blueprint
 *
 * The API key is taken from the request headers (the key pasted in Settings)
 * when present, otherwise from the server environment.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, request }) => {
  const creds = credentialsFromRequest(request);
  const client = createPrintifyClient(creds.printify?.apiKey);

  if (!client.configured) {
    return json(
      {
        configured: false,
        error:
          "Printify is not configured. Paste your Printify API key in Settings, or set PRINTIFY_API_KEY on the server.",
      },
      503,
    );
  }
  const id = url.searchParams.get("id");
  const category = url.searchParams.get("category") ?? undefined;
  const wantsProviders = url.searchParams.get("providers") === "1";

  try {
    if (!id) {
      return json({ configured: true, blueprints: await client.listBlueprints(category) });
    }
    if (wantsProviders) {
      return json({ configured: true, ...(await client.listProviders(Number(id))) });
    }
    const detail: PrintifyBlueprintDetail = await client.getBlueprint(Number(id));
    return json({ configured: true, blueprint: detail });
  } catch (error) {
    return fail(error);
  }
};
