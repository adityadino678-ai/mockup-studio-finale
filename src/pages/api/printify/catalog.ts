import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import {
  createPrintifyClient,
  PrintifyError,
  type PrintifyBlueprint,
  type PrintifyBlueprintDetail,
} from "@/lib/server/printify";
import {
  buildColourTemplateInput,
  colourPayloadFromProduct,
  pickColourTemplateVariant,
  TEMPLATE_ARTWORK_BASE64,
  type ColourTemplatePayload,
} from "@/lib/server/colour-template";
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

/**
 * Shop product index memo for `colors=1` (private, per shop, ~10 min).
 * Deliberately isolate-memory only — the shared edge cache must never hold
 * a seller's private product list. Keyed by shop id.
 */
const SHOP_PRODUCT_MEMO_TTL_MS = 10 * 60 * 1000;
const SHOP_PRODUCT_MAX_PAGES = 10;
const shopProductMemo = new Map<
  number,
  { at: number; products: import("@/lib/server/printify").PrintifyShopProduct[] }
>();

/**
 * Derived colour values from a PROVISIONED throwaway template.
 *
 * The VALUES are public catalogue facts (colour name → hex for a blueprint +
 * provider) — never the seller's private product list — so the isolate may
 * share them: the second visitor picking the same product type gets exact
 * hexes with zero extra template creations. Keyed by blueprint:provider.
 */
const PROVISIONED_COLOUR_MEMO_TTL_MS = 6 * 60 * 60 * 1000;
const provisionedColourMemo = new Map<
  string,
  { at: number; payload: ColourTemplatePayload }
>();

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
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }
  const creds = credentialsFromRequest(request);
  const client = createPrintifyClient(creds.printify?.apiKey);

  if (!client.configured) {
    return json(
      {
        configured: false,
        error:
          "Printify is not configured. Paste your Printify API key in Settings → API connections.",
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
      // Providers are public catalogue data, identical for every visitor, so
      // the edge can hold them. `colors=1` is deliberately NOT cached: it
      // reads the seller's own shop products to find a template product.
      const cached = await cachedCatalogue(url);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("x-catalog-cache", "edge");
        return hit;
      }
      const response = json({ configured: true, ...(await client.listProviders(Number(id))) });
      response.headers.set("x-catalog-cache", "miss");
      await putInCatalogueCache(url, response);
      return response;
    }
    if (wantsColors) {
      // Real colour hexes only exist on a PRODUCT, never in the catalogue.
      // Find one the seller already made for the same blueprint + provider
      // and read its option values. See AGENTS.md.
      const blueprintId = Number(id);
      const printProviderId = Number(url.searchParams.get("provider"));
      const preferredShopId = creds.printify?.shopId;
      // Parallel: resolve shops while already reading the first product page
      // for the selected shop (immediate when the user picked one in Settings).
      const firstPagePromise =
        preferredShopId !== undefined
          ? client.listShopProducts(preferredShopId, 50, 1).catch(() => null)
          : null;
      const shopId = await client.resolveShopId(preferredShopId);
      const firstPage = firstPagePromise ? await firstPagePromise : null;

      let match: import("@/lib/server/printify").PrintifyShopProduct | undefined;
      let approximateMatch: import("@/lib/server/printify").PrintifyShopProduct | undefined;

      const memo = shopProductMemo.get(shopId);
      if (memo && Date.now() - memo.at < SHOP_PRODUCT_MEMO_TTL_MS) {
        for (const p of memo.products) {
          if (p.blueprint_id !== blueprintId) continue;
          if (!Number.isNaN(printProviderId) && p.print_provider_id === printProviderId) {
            match = p;
            break;
          }
          approximateMatch ??= p;
        }
      } else {
        // Page through all products (limit 50, up to 10 pages) and stop as
        // soon as an exact match is found. Keep the first same-blueprint
        // product as an approximate fallback.
        const all: import("@/lib/server/printify").PrintifyShopProduct[] = [];
        for (let page = 1; page <= SHOP_PRODUCT_MAX_PAGES; page++) {
          const products =
            page === 1 && firstPage !== null
              ? firstPage
              : await client.listShopProducts(shopId, 50, page);
          if (!Array.isArray(products) || products.length === 0) break;
          all.push(...products);
          for (const p of products) {
            if (p.blueprint_id !== blueprintId) continue;
            if (!Number.isNaN(printProviderId) && p.print_provider_id === printProviderId) {
              match = p;
              break;
            }
            approximateMatch ??= p;
          }
          if (match) break;
          if (products.length < 50) break;
        }
        // Cache the index for the next request (private, per shop, 10 min).
        shopProductMemo.set(shopId, { at: Date.now(), products: all });
      }

      const chosen = match ?? approximateMatch;
      const isApproximate = !match && Boolean(approximateMatch);
      if (!chosen) {
        // No product for this blueprint + provider anywhere in the shop: the
        // palette PROVISIONS one. With the visitor's own key it creates a
        // hidden one-variant draft, reads the product's real colour values,
        // and deletes the draft in the same request (finally, so a failure
        // later in the flow still cleans it up). The derived values are
        // public catalogue facts, so they are memoised per blueprint +
        // provider - the NEXT visitor picking this product type gets exact
        // hexes with zero extra creations. Anything that fails here falls
        // back to the honest "no source" answer; the palette then labels
        // itself approximate instead of pretending.
        const memoKey = `${blueprintId}:${Number.isNaN(printProviderId) ? "?" : printProviderId}`;
        const memo = provisionedColourMemo.get(memoKey);
        if (memo && Date.now() - memo.at < PROVISIONED_COLOUR_MEMO_TTL_MS) {
          return json({ ...memo.payload, provisioned: true, templateProductId: undefined });
        }
        try {
          const variants = await client.listVariants(blueprintId, printProviderId);
          const plan = pickColourTemplateVariant(variants);
          if (!plan) {
            return json({
              configured: true,
              source: "none",
              colors: [],
              sizes: [],
              variants: [],
            });
          }
          const uploaded = await client.uploadImage(
            TEMPLATE_ARTWORK_BASE64,
            "mockup-studio-colour-template.png",
          );
          const created = await client.createProduct(
            buildColourTemplateInput({
              blueprintId,
              printProviderId,
              plan,
              imageId: uploaded.id,
            }),
          );
          try {
            const full = await client.getProduct(shopId, created.id);
            const payload = colourPayloadFromProduct(full, { provisioned: true });
            provisionedColourMemo.set(memoKey, { at: Date.now(), payload });
            return json({ configured: true, ...payload, templateProductId: undefined });
          } finally {
            // The draft's whole life is this request: whatever happened
            // above, it is deleted before the request ends. A failed delete
            // leaves a draft named "Mockup Studio colour template (safe to
            // delete)" - findable and harmless.
            await client.deleteProduct(shopId, created.id).catch(() => undefined);
          }
        } catch {
          return json({
            configured: true,
            source: "none",
            colors: [],
            sizes: [],
            variants: [],
          });
        }
      }
      // The list endpoint may omit variants, so read the product in full.
      // The full detail is fetched only for the match.
      const full = await client.getProduct(shopId, chosen.id).catch(() => chosen);
      return json({
        configured: true,
        ...colourPayloadFromProduct(full, {
          approximate: isApproximate,
          templateProductId: chosen.id,
        }),
      });
    }
    if (provider) {
      // Variants are the colour/size list the palette renders from, and the
      // payload is large (placeholders per variant). Public catalogue data, so
      // the edge holds it for an hour; the browser holds its own copy for a day.
      const cached = await cachedCatalogue(url);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("x-catalog-cache", "edge");
        return hit;
      }
      const variants = await client.listVariants(Number(id), Number(provider));
      const response = json({ configured: true, variants });
      response.headers.set("x-catalog-cache", "miss");
      await putInCatalogueCache(url, response);
      return response;
    }
    const detail: PrintifyBlueprintDetail = await client.getBlueprint(Number(id));
    return json({ configured: true, blueprint: detail });
  } catch (error) {
    return fail(error);
  }
};
