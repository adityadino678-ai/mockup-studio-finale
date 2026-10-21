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
 * GET /api/printify/catalog?q=tee&limit=25         -> blueprint list filtered by tokens
 * GET /api/printify/catalog?id=123                 -> blueprint detail (identity only)
 * GET /api/printify/catalog?id=123&providers=1     -> print providers for a blueprint
 * GET /api/printify/catalog?id=123&provider=29     -> variants (sizes/colors + print areas)
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
  const wantsColors = url.searchParams.get("colors") === "1";
  const provider = url.searchParams.get("provider");
  const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const limit = Math.trunc(Number(url.searchParams.get("limit"))) || 0;

  try {
    if (!id) {
      let blueprints = await client.listBlueprints(category);
      if (q) {
        // Every whitespace-separated token must appear somewhere in the row, so
        // "unisex tee" narrows rather than widens. Keeps big result sets small.
        const tokens = q.split(/\s+/).filter(Boolean).slice(0, 8);
        blueprints = blueprints.filter((b) => {
          const haystack = `${b.title} ${b.brand} ${b.model} ${b.category ?? ""}`.toLowerCase();
          return tokens.every((token) => haystack.includes(token));
        });
      }
      if (limit > 0) blueprints = blueprints.slice(0, limit);
      return json({ configured: true, blueprints });
    }
    if (wantsProviders) {
      return json({ configured: true, ...(await client.listProviders(Number(id))) });
    }
    if (wantsColors) {
      // Real colour hexes only exist on a PRODUCT, never in the catalogue.
      // Find one the seller already made for the same blueprint + provider
      // and read its option values. See AGENTS.md.
      const blueprintId = Number(id);
      const printProviderId = Number(url.searchParams.get("provider"));
      const shopId = await client.resolveShopId();
      const products = await client.listShopProducts(shopId);
      const match = products.find(
        (p) =>
          p.blueprint_id === blueprintId &&
          (Number.isNaN(printProviderId) || p.print_provider_id === printProviderId),
      );
      if (!match) {
        return json({ configured: true, source: "none", colors: [], sizes: [], variants: [] });
      }
      // The list endpoint may omit variants, so read the product in full.
      const full = await client.getProduct(shopId, match.id).catch(() => match);
      const options = full.options ?? [];
      const colourOption = options.find((o) => /colou?r/i.test(o.type ?? o.name ?? ""));
      const sizeOption = options.find((o) => /size/i.test(o.type ?? o.name ?? ""));
      return json({
        configured: true,
        source: "product",
        templateProductId: match.id,
        colors: (colourOption?.values ?? []).map((v) => ({
          id: v.id,
          title: v.title,
          colors: v.colors ?? [],
        })),
        sizes: (sizeOption?.values ?? []).map((v) => ({ id: v.id, title: v.title })),
        variants: (full.variants ?? []).map((v) => ({
          id: v.id,
          title: v.title,
          options: v.options ?? [],
        })),
      });
    }
    if (provider) {
      const variants = await client.listVariants(Number(id), Number(provider));
      return json({ configured: true, variants });
    }
    const detail: PrintifyBlueprintDetail = await client.getBlueprint(Number(id));
    return json({ configured: true, blueprint: detail });
  } catch (error) {
    return fail(error);
  }
};
