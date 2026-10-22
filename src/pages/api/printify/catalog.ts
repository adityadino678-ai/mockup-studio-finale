import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import {
  createPrintifyClient,
  PrintifyError,
  type PrintifyBlueprint,
  type PrintifyBlueprintDetail,
} from "@/lib/server/printify";

function fail(error: unknown) {
  if (error instanceof PrintifyError) {
    // A 401/403 from Printify means the key that was sent is not usable - the
    // visitor's pasted key or the server's PRINTIFY_API_KEY. That is a
    // configuration problem they can fix, not a gateway fault, so report it as
    // an unavailable integration (503 + configured:false) with a message that
    // names the cause. It used to be a bare 502 "Unauthenticated", which made a
    // rejected key look identical to Printify being down.
    if (error.status === 401 || error.status === 403) {
      return json(
        {
          configured: false,
          error: `Printify rejected the API key (HTTP ${error.status}: ${error.message}). Update it in Settings, or set a valid PRINTIFY_API_KEY on the server.`,
          status: error.status,
        },
        { status: 503 },
      );
    }
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
 * GET /api/printify/catalog?id=123&provider=29&colors=1 -> the colour values of a template product
 *
 * The API key is taken from the request headers (the key pasted in Settings)
 * when present, otherwise from the server environment.
 */
export const prerender = false;

/** How long the catalogue is cached. Printify adds products slowly. */
const CATALOGUE_TTL_SECONDS = 3600;

/**
 * The blueprint list is the same for everyone, is 2.4 MB, and takes several
 * seconds to fetch from Printify. It is memoised in the isolate so a warm
 * isolate answers instantly, and the browser keeps its own copy for a day.
 */
let catalogueMemo: { at: number; blueprints: unknown[] } | null = null;
const CATALOGUE_MEMO_TTL_MS = CATALOGUE_TTL_SECONDS * 1000;

/** Cloudflare's `caches.default` is not in the DOM lib's CacheStorage type. */
function edgeCache(): Cache | null {
  if (typeof caches === "undefined") return null;
  const store = caches as unknown as { default?: Cache };
  return store.default ?? null;
}

/**
 * The blueprint list is the same for everyone and changes rarely, but it is
 * 2.4 MB and takes ~10 s to fetch. Caching it at the edge turns every first
 * visit into a cache hit.
 */
async function cachedCatalogue(url: URL): Promise<Response | null> {
  const cache = edgeCache();
  if (!cache) return null;
  const key = new Request(url.toString());
  try {
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {
    return null;
  }
  return null;
}

async function putInCatalogueCache(url: URL, response: Response): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  try {
    const copy = response.clone();
    copy.headers.set("Cache-Control", `public, max-age=${CATALOGUE_TTL_SECONDS}`);
    await cache.put(new Request(url.toString()), copy);
  } catch {
    // A cache that will not take the object must never fail the request.
  }
}

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
      // The catalogue is the same for everyone and is 2.4 MB, so it is served
      // from the isolate's memory, then from the edge, and only then fetched
      // from Printify. The search and category filtering happen client-side
      // against the cached copy, so only this one shape is ever cached.
      const cached = await cachedCatalogue(url);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("x-catalog-cache", "edge");
        return hit;
      }

      let blueprints: PrintifyBlueprint[];
      if (catalogueMemo && Date.now() - catalogueMemo.at < CATALOGUE_MEMO_TTL_MS) {
        blueprints = catalogueMemo.blueprints as PrintifyBlueprint[];
      } else {
        blueprints = await client.listBlueprints(category);
        catalogueMemo = { at: Date.now(), blueprints };
      }

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
      const response = json({ configured: true, blueprints });
      response.headers.set("x-catalog-cache", catalogueMemo ? "memo" : "miss");
      await putInCatalogueCache(url, response);
      return response;
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
