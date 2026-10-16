import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import {
  isPrintifyConfigured,
  listBlueprints,
  getBlueprint,
  listProviders,
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
 */
export const GET: APIRoute = async ({ url }) => {
  if (!isPrintifyConfigured()) {
    return json(
      {
        configured: false,
        error:
          "Printify is not configured. Add PRINTIFY_API_KEY to .env.local and restart the dev server to enable the live catalog.",
      },
      503,
    );
  }
  const id = url.searchParams.get("id");
  const category = url.searchParams.get("category") ?? undefined;
  const wantsProviders = url.searchParams.get("providers") === "1";

  try {
    if (!id) {
      return json({ configured: true, blueprints: await listBlueprints(category) });
    }
    if (wantsProviders) {
      return json({ configured: true, ...(await listProviders(Number(id))) });
    }
    const detail: PrintifyBlueprintDetail = await getBlueprint(Number(id));
    return json({ configured: true, blueprint: detail });
  } catch (error) {
    return fail(error);
  }
};
