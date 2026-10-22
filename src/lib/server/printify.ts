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
  sales_channel?: string;
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
    let res: Response;
    try {
      res = await fetch(`${PRINTIFY_BASE}${path}`, {
        ...init,
        headers: { ...authHeaders(), ...(init.headers ?? {}) },
        cache: "no-store",
      });
    } catch (error) {
      // A dropped connection is retried once; the body is always a string, so
      // replaying the request is safe.
      if (attempt < 1) {
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
      // Printify's gateway has answered a large upload with a bare 502 that a
      // retry then completed, so give transient failures one more chance.
      if (TRANSIENT_STATUS.includes(res.status) && attempt < 1) {
        await sleep(RETRY_DELAY_MS);
        return request<T>(path, init, attempt + 1);
      }
      throw new PrintifyError(extractError(data, res.status), res.status, data);
    }
    return data as T;
  }

  async function resolveShopId(): Promise<number> {
    const shops = await request<PrintifyShop[]>("/shops.json");
    if (!Array.isArray(shops) || shops.length === 0) {
      throw new PrintifyError("This Printify account has no shops connected", 404, shops);
    }
    return shops[0].id;
  }

  return {
    configured,

    isConfigured: () => configured,

    /** GET /shops.json */
    async listShops(): Promise<PrintifyShop[]> {
      const shops = await request<PrintifyShop[]>("/shops.json");
      return Array.isArray(shops) ? shops : [];
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

    /** POST /uploads/images.json — uploads base64 artwork, returns the asset id. */
    uploadImage(base64: string, filename: string): Promise<{ id: string }> {
      return request<{ id: string }>("/uploads/images.json", {
        method: "POST",
        body: JSON.stringify({ file_name: filename, contents: base64 }),
      });
    },

    resolveShopId,

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
          if (!group.imageId || group.variantIds.length === 0) continue;
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
     */
    async listShopProducts(shopId: number, limit = 50): Promise<PrintifyShopProduct[]> {
      const data = await request<unknown>(`/shops/${shopId}/products.json?limit=${limit}`);
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown })?.data)
          ? (data as { data: unknown[] }).data
          : [];
      return list as PrintifyShopProduct[];
    },

    /** GET /shops/{shop_id}/products/{product_id}.json - one product in full. */
    getProduct(shopId: number, productId: string): Promise<PrintifyShopProduct> {
      return request<PrintifyShopProduct>(`/shops/${shopId}/products/${productId}.json`);
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
