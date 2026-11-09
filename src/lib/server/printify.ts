// Server-side Printify API client. Credentials may come from the environment
// or, when a visitor pastes their own key in Settings, from the request headers
// — see `lib/server/creds.ts`. Keys are never persisted on the server. All calls
// return normalized results or throw a `PrintifyError` with the provider's own
// message so the UI can report real failures instead of pretending success.

import { serverEnv } from "@/lib/server/env";

const PRINTIFY_BASE = "https://api.printify.com/v1";

/** Gateway statuses Printify has returned transiently (a retry then succeeded). */
const TRANSIENT_STATUS = [502, 503, 504];
const RETRY_DELAY_MS = 1500;
/** 429 is retried more than the gateway errors: it is a rate limit, not a fault. */
const RATE_LIMIT_RETRIES = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PrintifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PrintifyError";
  }
}

// --- Types (subset of the documented shapes we consume) ---

export interface PrintifyBlueprint {
  id: number;
  title: string;
  brand: string;
  model: string;
  category?: string;
  image?: string;
  /** The catalogue returns an array of image urls. */
  images?: string[];
  /** Stripped before the catalogue is sent on: it is never rendered. */
  description?: string;
}

/** A printable area on a variant (Printify calls these "placeholders"). */
export interface PrintifyPlaceholder {
  position: string;
  decoration_method?: string;
  width?: number;
  height?: number;
}

/**
 * A catalog variant. Printify returns variants only for a specific print
 * provider (`/print_providers/{id}/variants.json`); the blueprint detail itself
 * carries no variants. `options` is an object like `{ color, size }` keyed by
 * option name, and each variant lists the printable areas it supports.
 */
export interface PrintifyVariant {
  id: number;
  title: string;
  options?: Record<string, string>;
  placeholders?: PrintifyPlaceholder[];
  available?: boolean;
}

/** Blueprint detail: identity only. Variants require a print provider. */
export interface PrintifyBlueprintDetail extends PrintifyBlueprint {
  description?: string;
  images?: string[];
  tags?: string[];
  features?: Array<{ name?: string; description?: string; image?: string }>;
  care_instructions?: string[];
}

export interface PrintifyProvider {
  id: number;
  title: string;
  decoration_methods?: string[];
}

export interface PrintifyShop {
  id: number;
  title: string;
  /** The connected sales channel (e.g. "etsy"); empty when there is none. */
  sales_channel?: string;
}

/** A product together with the shop that actually owns it. */
export interface PrintifyOwnedProduct {
  shopId: number;
  shop: PrintifyShop;
  product: PrintifyShopProduct;
}

/** Printify's "Manage my stores" screen, where a sales channel is connected. */
export const PRINTIFY_MANAGE_STORES_URL = "https://printify.com/app/account/my-stores";

/**
 * Parses a shop id from a header or a JSON body. Only a positive integer is a
 * shop id; everything else (blank, "0", "1.5", "abc") is rejected rather than
 * quietly coerced.
 */
export function normalizeShopId(value: unknown): number | undefined {
  let numeric: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Digits only: "1e3" and "+42" are not shop ids, even though Number()
    // would accept them.
    numeric = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  }
  return typeof numeric === "number" && Number.isInteger(numeric) && numeric > 0
    ? numeric
    : undefined;
}

/** `sales_channel` is a plain string in the API; normalize it once. */
export function normalizeSalesChannel(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A shop can publish a product only when Printify reports a sales channel for
 * it. A shop without one is a "custom/manual" store, and publishing answers
 * error 8254.
 */
export function isSalesChannelConnected(
  shop: Pick<PrintifyShop, "sales_channel"> | null | undefined,
): boolean {
  return normalizeSalesChannel(shop?.sales_channel) !== "";
}

/** Normalizes the shop list: trimmed strings and usable numeric ids only. */
export function normalizeShops(shops: PrintifyShop[]): PrintifyShop[] {
  const out: PrintifyShop[] = [];
  for (const shop of shops) {
    const id = normalizeShopId(shop?.id);
    if (!id) continue;
    out.push({
      ...shop,
      id,
      title: typeof shop.title === "string" ? shop.title.trim() : "",
      sales_channel: normalizeSalesChannel(shop.sales_channel),
    });
  }
  return out;
}

/** The actionable message for a shop that cannot receive an Etsy product. */
export function salesChannelErrorMessage(shop: { id: number; title: string }): string {
  const title = shop.title.trim() || `Shop ${shop.id}`;
  return `Shop "${title}" (#${shop.id}) is not connected to Etsy. Connect it in Printify (Manage my stores), or create and publish this listing in the shop that is connected.`;
}

/** A product in the shop, as far as the list endpoint reports it. */
export interface PrintifyShopProduct {
  id: string;
  title: string;
  blueprint_id?: number;
  print_provider_id?: number;
  visible?: boolean;
  options?: PrintifyProductOption[];
  variants?: PrintifyProductVariant[];
}

/** A product option: a named group of selectable values. */
export interface PrintifyProductOption {
  name: string;
  type: string;
  values: Array<{ id: number; title: string; colors?: string[] }>;
  display_in_preview?: boolean;
}

/** A product variant: the option value ids it is made of. */
export interface PrintifyProductVariant {
  id: number;
  title: string;
  price?: number;
  is_enabled?: boolean;
  options: number[];
}

export interface PrintifyProductCreated {
  id: string;
  title: string;
  permalink?: string;
  print_areas?: unknown;
}

/** The media-library record returned by `/uploads/images.json`. */
export interface PrintifyUploadedImage {
  id: string;
  file_name?: string;
  preview_url?: string;
  /** Present on some responses; not required for the mockup bridge. */
  src?: string;
}

/** The custom mockup record returned by the product mockups endpoint. */
export interface PrintifyProductMockup {
  id: string;
  src: string;
}

export interface CreatePrintifyProductInput {
  title: string;
  description?: string;
  /** Search/listing tags for the product. */
  tags?: string[];
  blueprintId: number;
  /** Print provider that fulfils the blueprint. Required by Printify. */
  printProviderId: number;
  /** Variant ids grouped by variant group (the app's own shape). */
  variants: Record<string, number[]>;
  /** Variant id → price in cents. Required by Printify for every enabled variant. */
  prices: Record<number, number>;
  /**
   * Print areas, one group per artwork. The groups MUST cover every enabled
   * variant: Printify rewrites a group's `variant_ids` to swallow anything
   * nobody named, and a variant that lands in the wrong group is printed with
   * the wrong artwork. See AGENTS.md.
   */
  printAreaGroups?: PrintifyPrintAreaGroup[];
  /**
   * Legacy single-artwork form: position → uploaded image id. Kept for the
   * agent tool. `print_areas` is REQUIRED by
   * Printify, so one of the two forms must always be present.
   */
  printAreas?: Record<string, string>;
  /** Optional storefront images (Printify also generates mockups automatically). */
  images?: Array<{ src: string; position?: string; is_default?: boolean }>;
  shopId?: number;
}

/**
 * A partial update of an existing product.
 *
 * Printify's own contract: "A product can be updated partially or as a whole
 * document. When updating variants, all variants must be present in the
 * request." This type only carries the fields the Listing preview owns - the
 * print areas and artwork are deliberately absent, so an update can never
 * reprint a product by accident.
 */
export interface UpdatePrintifyProductInput {
  productId: string;
  /** Preferred shop; the product's real owner is still resolved first. */
  shopId?: number;
  title?: string;
  description?: string;
  tags?: string[];
  /** Price in cents applied to every existing variant. */
  price?: number;
}

/** One artwork group: the variants it prints on, and where it sits. */
export interface PrintifyPrintAreaGroup {
  /** The variants this artwork is printed on. */
  variantIds: number[];
  /** Print area position, e.g. "front". */
  position: string;
  /** The uploaded image id. */
  imageId: string;
  /** Centre X within the print area, 0..1 (0.5 = centred). */
  x?: number;
  /** Centre Y within the print area, 0..1. */
  y?: number;
  /** Image width as a fraction of the print-area width. */
  scale?: number;
  /** Rotation in degrees, clockwise. */
  angle?: number;
}

function extractError(data: unknown, status: number): string {
  const root = (data ?? {}) as { error?: unknown; message?: string };
  const raw = root.error;
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const nested = (typeof obj.errors === "object" && obj.errors !== null ? obj.errors : {}) as Record<
    string,
    unknown
  >;
  // Printify nests the useful text in `error.errors.reason` for some failures
  // (e.g. an image its pipeline rejects) and only says "Operation failed." at
  // the top level, so prefer the deepest specific message available.
  const candidates = [
    nested.reason,
    nested.message,
    obj.reason,
    obj.message,
    typeof raw === "string" ? raw : undefined,
    root.message,
  ];
  const message = candidates.find((c): c is string => typeof c === "string" && c.trim().length > 0);
  return message ?? `Printify request failed with HTTP ${status}`;
}

/**
 * Returns a Printify client bound to a single API key. When no key is supplied
 * (and none is set on the server) every call throws a 501 `PrintifyError`, which
 * endpoints translate into an honest 503 "not configured" response.
 */
export function createPrintifyClient(explicitKey?: string) {
  const key = explicitKey ?? serverEnv.printifyApiKey() ?? "";
  const configured = !!key;

  function authHeaders(): HeadersInit {
    // Printify requires a User-Agent on every request (see API usage
    // guidelines) and accepts the token as a bearer token. The X-API-Key header
    // is kept for older integrations. Sending all three is harmless.
    return {
      "Content-Type": "application/json",
      "User-Agent": "MockupStudio/0.2 (+https://mockup-studio.adityadino678.workers.dev)",
      Authorization: `Bearer ${key}`,
      "X-API-Key": key,
    };
  }

  async function request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    if (!configured) {
      throw new PrintifyError("Printify API key is not configured", 501);
    }
    const method = (init.method ?? "GET").toUpperCase();
    // A gateway error or a dropped connection may arrive AFTER Printify
    // accepted a POST. Replaying that can create duplicate media/mockups, so
    // only replay methods that are safe to repeat. A 429 was not processed, so
    // it stays retryable for every method.
    const replaySafe = method === "GET" || method === "PUT" || method === "DELETE";
    let res: Response;
    try {
      res = await fetch(`${PRINTIFY_BASE}${path}`, {
        ...init,
        headers: { ...authHeaders(), ...(init.headers ?? {}) },
        cache: "no-store",
      });
    } catch (error) {
      if (replaySafe && attempt < 1) {
        await sleep(RETRY_DELAY_MS);
        return request<T>(path, init, attempt + 1);
      }
      throw error;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      // Rate limits back off more patiently than a gateway error. Honour
      // Retry-After when Printify sends it, capped so a bad header cannot
      // hold the request open indefinitely.
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(8000, retryAfter * 1000)
          : RETRY_DELAY_MS * (attempt + 1);
        await sleep(wait);
        return request<T>(path, init, attempt + 1);
      }
      // Printify's gateway has answered a read with a bare 502 that a retry
      // then completed, so give transient failures on replay-safe methods one
      // more chance. Never replay a POST here: it may already have been applied.
      if (replaySafe && TRANSIENT_STATUS.includes(res.status) && attempt < 1) {
        await sleep(RETRY_DELAY_MS);
        return request<T>(path, init, attempt + 1);
      }
      throw new PrintifyError(extractError(data, res.status), res.status, data);
    }
    return data as T;
  }

  async function fetchShops(): Promise<PrintifyShop[]> {
    const shops = await request<PrintifyShop[]>("/shops.json");
    return Array.isArray(shops) ? normalizeShops(shops) : [];
  }

  /**
   * Resolves the shop to work in.
   *
   * A preferred shop wins when it exists on this account. Otherwise prefer the
   * first shop that is connected to a sales channel: a product created in an
   * unconnected shop can never be published (Printify error 8254), so silently
   * choosing shops[0] is how a publish used to fail after the product existed.
   */
  async function resolveShopId(preferred?: number): Promise<number> {
    const shops = await fetchShops();
    if (shops.length === 0) {
      throw new PrintifyError("This Printify account has no shops connected", 404, shops);
    }
    const wanted = normalizeShopId(preferred);
    if (wanted !== undefined) {
      const match = shops.find((shop) => shop.id === wanted);
      if (match) return match.id;
    }
    const connected = shops.find((shop) => isSalesChannelConnected(shop));
    return (connected ?? shops[0]).id;
  }

  /**
   * Finds the shop that OWNS a product by asking each shop for it, starting
   * with the preferred one. Printify product ids are unique across the account
   * but the product API is shop-scoped, so a request to the wrong shop is a
   * 404 - never an excuse to use that shop anyway.
   */
  async function resolveProductShop(
    preferred: number | undefined,
    productId: string,
  ): Promise<PrintifyOwnedProduct | null> {
    const shops = await fetchShops();
    const wanted = normalizeShopId(preferred);
    const preferredShop = wanted === undefined ? undefined : shops.find((shop) => shop.id === wanted);
    const ordered = preferredShop
      ? [preferredShop, ...shops.filter((shop) => shop.id !== preferredShop.id)]
      : shops;
    for (const shop of ordered) {
      try {
        const product = await request<PrintifyShopProduct>(
          `/shops/${shop.id}/products/${encodeURIComponent(productId)}.json`,
        );
        return { shopId: shop.id, shop, product };
      } catch (error) {
        // A 404 means "not in this shop" and is expected while searching.
        if (error instanceof PrintifyError && error.status === 404) continue;
        throw error;
      }
    }
    return null;
  }

  return {
    configured,

    isConfigured: () => configured,

    /** GET /shops.json */
    async listShops(): Promise<PrintifyShop[]> {
      return fetchShops();
    },

    /**
     * GET /catalog/blueprints.json
     *
     * The catalogue is ~2,900 products. Only the fields the app actually
     * uses are sent on: the HTML `description` (never rendered) and all but
     * the first image url (the product grid shows one photo). That takes the
     * payload from 5.2 MB to well under 1 MB, which matters because it is
     * streamed through the Worker.
     */
    async listBlueprints(category?: string): Promise<PrintifyBlueprint[]> {
      const qs = category ? `?category=${encodeURIComponent(category)}` : "";
      const data = await request<PrintifyBlueprint[]>(`/catalog/blueprints.json${qs}`);
      if (!Array.isArray(data)) return [];
      return data.map((b) => ({
        id: b.id,
        title: b.title,
        brand: b.brand,
        model: b.model,
        category: b.category,
        images: b.images?.slice(0, 1),
      }));
    },

    /** GET /catalog/blueprints/{id}.json — identity only; no variants. */
    getBlueprint(id: number): Promise<PrintifyBlueprintDetail> {
      return request<PrintifyBlueprintDetail>(`/catalog/blueprints/${id}.json`);
    },

    /** GET /catalog/blueprints/{id}/print_providers.json */
    async listProviders(blueprintId: number): Promise<{ providers: PrintifyProvider[] }> {
      const providers = await request<PrintifyProvider[]>(
        `/catalog/blueprints/${blueprintId}/print_providers.json`,
      );
      return { providers: Array.isArray(providers) ? providers : [] };
    },

    /**
     * GET /catalog/blueprints/{id}/print_providers/{pid}/variants.json
     * Variants (sizes/colors) and their printable areas are provider-specific.
     */
    async listVariants(
      blueprintId: number,
      printProviderId: number,
      includeOutOfStock = true,
    ): Promise<PrintifyVariant[]> {
      const qs = includeOutOfStock ? "?show-out-of-stock=1" : "";
      const data = await request<unknown>(
        `/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json${qs}`,
      );
      // Despite the docs the endpoint returns an object — { id, title, variants }
      // — not a bare array; tolerate both shapes.
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { variants?: unknown })?.variants)
          ? (data as { variants: unknown[] }).variants
          : [];
      return list as PrintifyVariant[];
    },

    /** POST /uploads/images.json — uploads base64 artwork, returns the media record. */
    uploadImage(base64: string, filename: string): Promise<PrintifyUploadedImage> {
      return request<PrintifyUploadedImage>("/uploads/images.json", {
        method: "POST",
        body: JSON.stringify({ file_name: filename, contents: base64 }),
      });
    },

    /**
     * POST /shops/{shop_id}/products/{product_id}/mockups.json
     *
     * Undocumented, but verified live (Oct 2026): form-urlencoded `file_url`
     * returns a custom mockup record. The media library URL is the file URL.
     */
    uploadProductMockup(
      shopId: number,
      productId: string,
      fileUrl: string,
    ): Promise<PrintifyProductMockup> {
      return request<PrintifyProductMockup>(
        `/shops/${shopId}/products/${encodeURIComponent(productId)}/mockups.json`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ file_url: fileUrl }).toString(),
        },
      );
    },

    /**
     * POST /shops/{shop_id}/products/{product_id}/publish.json
     *
     * Verified contract (Oct 2026, see AGENTS.md): the body is a set of
     * BOOLEANS, one per field — each flag says "publish this field"; it is not
     * a simple toggle. Publishing an UNPUBLISHED draft is the only path; an
     * already-published product errors upstream, and that error surfaces
     * verbatim through `extractError`.
     */
    publishProduct(shopId: number, productId: string): Promise<unknown> {
      return request<unknown>(
        `/shops/${shopId}/products/${encodeURIComponent(productId)}/publish.json`,
        {
          method: "POST",
          body: JSON.stringify({
            title: true,
            description: true,
            images: true,
            variants: true,
            tags: true,
            keyFeatures: true,
            shipping_template: true,
          }),
        },
      );
    },

    resolveShopId,

    /** The shop that owns a product, searching every shop when needed. */
    resolveProductShop,

    /**
     * POST /shops/{shop_id}/products.json. Builds the documented payload:
     * every enabled variant carries a `price` in cents, `print_provider_id` is
     * required, and print-area image ids are the strings Printify returns from
     * the upload endpoint (not numbers).
     */
    async createProduct(input: CreatePrintifyProductInput): Promise<PrintifyProductCreated> {
      if (!input.printProviderId) {
        throw new PrintifyError("A print provider is required to create a product", 400);
      }
      const shopId = input.shopId ?? (await resolveShopId());
      const variantIds = Object.values(input.variants).flat();
      if (variantIds.length === 0) {
        throw new PrintifyError("At least one variant must be selected", 400);
      }
      const missingPrice = variantIds.filter((id) => !(input.prices[id] > 0));
      if (missingPrice.length > 0) {
        throw new PrintifyError(
          "Every selected variant needs a price. Printify requires a price in cents per variant.",
          400,
        );
      }
      const printAreas: Array<{
        variant_ids: number[];
        placeholders: Array<{
          position: string;
          images: Array<{ id: string; x: number; y: number; scale: number; angle: number }>;
        }>;
      }> = [];

      if (input.printAreaGroups && input.printAreaGroups.length > 0) {
        // One group per artwork. `variant_ids` decides which colour the
        // artwork is printed on, so the groups must partition the variants.
        for (const group of input.printAreaGroups) {
          if (!group.imageId || group.variantIds.length === 0) {
            // Dropping the group would leave its variants unclaimed, and
            // Printify appends unclaimed variants to the LAST group - so the
            // product would be created with the wrong artwork and no error.
            // Refuse instead of building a product that prints the wrong file.
            throw new PrintifyError(
              "A print area group has no artwork or no variants. Every selected variant must carry its own artwork before a product can be created.",
              400,
            );
          }
          printAreas.push({
            variant_ids: group.variantIds,
            placeholders: [
              {
                position: group.position,
                images: [
                  {
                    id: String(group.imageId),
                    x: group.x ?? 0.5,
                    y: group.y ?? 0.5,
                    scale: group.scale ?? 1,
                    angle: group.angle ?? 0,
                  },
                ],
              },
            ],
          });
        }
      } else {
        // Legacy single-artwork form: every enabled variant gets the same image.
        for (const [position, imageId] of Object.entries(input.printAreas ?? {})) {
          if (!imageId || imageId === "pending") continue;
          printAreas.push({
            variant_ids: variantIds,
            placeholders: [
              {
                position,
                images: [{ id: String(imageId), x: 0.5, y: 0.5, scale: 1, angle: 0 }],
              },
            ],
          });
        }
      }

      if (printAreas.length === 0) {
        // Printify rejects a product without print areas (code 8150), so fail
        // here with a message the user can act on instead of letting the
        // gateway answer "Validation failed."
        throw new PrintifyError(
          "A product needs artwork: attach at least one design to a print area before creating it.",
          400,
        );
      }

      const body: Record<string, unknown> = {
        title: input.title,
        description: input.description ?? "",
        blueprint_id: input.blueprintId,
        print_provider_id: input.printProviderId,
        variants: variantIds.map((id) => ({ id, price: input.prices[id], is_enabled: true })),
        print_areas: printAreas,
      };
      if (input.tags?.length) body.tags = input.tags;
      if (input.images?.length) body.images = input.images;

      return request<PrintifyProductCreated>(`/shops/${shopId}/products.json`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /**
     * PUT /shops/{shop_id}/products/{product_id}.json — a PARTIAL update.
     *
     * The listing preview owns the copy and the price, not the artwork, so this
     * sends only title/description/tags and (when asked) the variants with the
     * new price. It never sends `print_areas`, so an update cannot move or
     * replace the printed artwork.
     *
     * Printify requires every variant in a variant update. The product is read
     * first, then every variant is echoed back with its existing `is_enabled`
     * flag and the new price - dropping a variant from the array would let
     * Printify rewrite the product's variant set.
     */
    async updateProduct(
      input: UpdatePrintifyProductInput,
    ): Promise<{ product: PrintifyShopProduct; shopId: number }> {
      const productId = input.productId?.trim();
      if (!productId) {
        throw new PrintifyError("A product id is required to update a product", 400);
      }
      const owned = await resolveProductShop(input.shopId, productId);
      if (!owned) {
        throw new PrintifyError(
          `Printify could not find product ${productId} in any shop on this account.`,
          404,
        );
      }

      const body: Record<string, unknown> = {};
      if (typeof input.title === "string") body.title = input.title;
      if (typeof input.description === "string") body.description = input.description;
      if (Array.isArray(input.tags)) body.tags = input.tags;
      if (input.price !== undefined) {
        const price = Math.round(input.price);
        if (!(price > 0)) {
          throw new PrintifyError("Price must be a positive number of cents", 400);
        }
        const variants = owned.product.variants ?? [];
        if (variants.length === 0) {
          throw new PrintifyError(
            "This product has no variants, so its price cannot be updated.",
            400,
          );
        }
        body.variants = variants.map((variant) => ({
          id: variant.id,
          price,
          is_enabled: variant.is_enabled !== false,
        }));
      }
      if (Object.keys(body).length === 0) {
        throw new PrintifyError("Nothing to update: send a title, description, tags or price", 400);
      }

      const product = await request<PrintifyShopProduct>(
        `/shops/${owned.shopId}/products/${encodeURIComponent(productId)}.json`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return { product, shopId: owned.shopId };
    },

    /** GET /shops.json (first shop, for a friendly "connected" label). */
    async getShopInfo(): Promise<PrintifyShop> {
      const shops = await request<PrintifyShop[]>("/shops.json");
      if (!Array.isArray(shops) || shops.length === 0) {
        throw new PrintifyError("This Printify account has no shops connected", 404, shops);
      }
      return shops[0];
    },

    /**
     * GET /shops/{shop_id}/products.json - the shop's existing products.
     *
     * This is how we find a TEMPLATE: a product the seller already made for
     * the same blueprint and print provider carries that provider's real
     * colour values and their hexes, which the catalogue never exposes.
     * `limit` may not exceed 50 (Printify contract). `page` is 1-based.
     */
    async listShopProducts(shopId: number, limit = 50, page = 1): Promise<PrintifyShopProduct[]> {
      const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit) || 50));
      const safePage = Math.max(1, Math.trunc(page) || 1);
      const data = await request<unknown>(
        `/shops/${shopId}/products.json?limit=${safeLimit}&page=${safePage}`,
      );
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown })?.data)
          ? (data as { data: unknown[] }).data
          : [];
      return list as PrintifyShopProduct[];
    },

    /** GET /shops/{shop_id}/products/{product_id}.json - one product in full. */
    getProduct(shopId: number, productId: string): Promise<PrintifyShopProduct> {
      return request<PrintifyShopProduct>(
        `/shops/${shopId}/products/${encodeURIComponent(productId)}.json`,
      );
    },
  };
}

export type PrintifyClient = ReturnType<typeof createPrintifyClient>;

export interface PrintifyProbe {
  shopCount: number;
  shopTitle?: string;
  ms: number;
}

/** Live connectivity probe: lists the account's shops. */
export async function probePrintify(apiKey: string): Promise<PrintifyProbe> {
  const client = createPrintifyClient(apiKey);
  const started = Date.now();
  const shops = await client.listShops();
  return { shopCount: shops.length, shopTitle: shops[0]?.title, ms: Date.now() - started };
}
