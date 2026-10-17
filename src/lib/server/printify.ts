// Server-side Printify API client. Credentials may come from the environment
// or, when a visitor pastes their own key in Settings, from the request headers
// — see `lib/server/creds.ts`. Keys are never persisted on the server. All calls
// return normalized results or throw a `PrintifyError` with the provider's own
// message so the UI can report real failures instead of pretending success.

import { serverEnv } from "@/lib/server/env";

const PRINTIFY_BASE = "https://api.printify.com/v1";

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
}

export interface PrintifyVariantOption {
  id: number;
  title: string;
  options: number[];
  available?: boolean;
  price_variant?: number;
}

export interface PrintifyPrintArea {
  id: string;
  title?: string;
  image?: string;
  position?: string;
  width?: number;
  height?: number;
}

export interface PrintifyBlueprintDetail extends PrintifyBlueprint {
  variants: PrintifyVariantOption[];
  print_areas: PrintifyPrintArea[];
}

export interface PrintifyProvider {
  id: number;
  title: string;
}

export interface PrintifyShop {
  id: number;
  title: string;
  sales_channel?: string;
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
  blueprintId: number;
  /** Print provider that fulfils the blueprint. Required by Printify. */
  printProviderId: number;
  /** Variant ids grouped by variant group (the app's own shape). */
  variants: Record<string, number[]>;
  /** Variant id → price in cents. Required by Printify for every enabled variant. */
  prices: Record<number, number>;
  /** Print area position → uploaded image id. */
  printAreas?: Record<string, string>;
  /** Optional storefront images (Printify also generates mockups automatically). */
  images?: Array<{ src: string; position?: string; is_default?: boolean }>;
  shopId?: number;
}

function extractError(data: unknown, status: number): string {
  const candidate =
    (data as { error?: { message?: string } })?.error?.message ??
    (data as { message?: string })?.message ??
    (data as { error?: string })?.error;
  return typeof candidate === "string" && candidate ? candidate : `Printify request failed with HTTP ${status}`;
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
    // Printify accepts the personal access token as a bearer token; the
    // X-API-Key header is kept for older integrations. Sending both is harmless.
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-API-Key": key,
    };
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!configured) {
      throw new PrintifyError("Printify API key is not configured", 501);
    }
    const res = await fetch(`${PRINTIFY_BASE}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init.headers ?? {}) },
      cache: "no-store",
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
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

    /** GET /catalog/blueprints.json */
    listBlueprints(category?: string): Promise<PrintifyBlueprint[]> {
      const qs = category ? `?category=${encodeURIComponent(category)}` : "";
      return request<PrintifyBlueprint[]>(`/catalog/blueprints.json${qs}`);
    },

    /** GET /catalog/blueprints/{id}.json */
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
      const printAreas = Object.entries(input.printAreas ?? {})
        .filter(([, imageId]) => imageId && imageId !== "pending")
        .map(([position, imageId]) => ({
          variant_ids: variantIds,
          placeholders: [
            { position, images: [{ id: String(imageId), x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
          ],
        }));

      const body: Record<string, unknown> = {
        title: input.title,
        description: input.description ?? "",
        blueprint_id: input.blueprintId,
        print_provider_id: input.printProviderId,
        variants: variantIds.map((id) => ({ id, price: input.prices[id], is_enabled: true })),
      };
      if (printAreas.length > 0) body.print_areas = printAreas;
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
