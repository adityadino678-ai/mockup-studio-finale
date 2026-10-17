import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { createPrintifyClient, PrintifyError } from "@/lib/server/printify";

interface CreateProductBody {
  /** Explicit user confirmation is required before anything is created remotely. */
  confirm: boolean;
  title: string;
  description?: string;
  /** Search/listing tags for the product. */
  tags?: string[];
  blueprintId: number;
  /** Print provider that fulfils the blueprint. Required by Printify. */
  printProviderId?: number;
  variants: Record<string, number[]>;
  /** Price in cents applied to every selected variant. */
  price?: number;
  /** Optional per-variant price overrides, in cents. */
  prices?: Record<string, number>;
  printAreas?: Record<string, string>;
  /** Base64 artwork to upload and attach to the print area. */
  artwork?: { base64: string; filename: string; printAreaId: string };
}

/**
 * Keep well under the Workers memory ceiling. A 25 MB base64 body plus its
 * decoded buffer can exceed the 128 MB limit; the client downscales artwork to
 * stay under this cap before uploading.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Printify rejects a product with more than this many enabled variants. */
const MAX_VARIANTS = 100;

/** Trims and dedupes tags; drops empties and anything past Printify's limit. */
function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const tag = String(raw).trim().slice(0, 255);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 13) break;
  }
  return out;
}

/**
 * Estimates decoded byte length from a base64 string without allocating a
 * buffer. `Buffer` does not exist in the Workers runtime, and decoding 8 MB just
 * to measure it would double the peak memory for no reason.
 */
function base64Bytes(base64: string): number {
  const clean = base64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "").replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const creds = credentialsFromRequest(request);
  const client = createPrintifyClient(creds.printify?.apiKey);

  if (!client.configured) {
    return json(
      {
        error:
          "Printify is not configured. Paste your Printify API key in Settings, or set PRINTIFY_API_KEY on the server, before creating products.",
      },
      503,
    );
  }

  let body: CreateProductBody;
  try {
    body = (await request.json()) as CreateProductBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.confirm !== true) {
    return json(
      { error: "Confirmation required: creating a product on Printify has external side effects." },
      428,
    );
  }
  if (!body.title?.trim()) {
    return json({ error: "Product title is required" }, 400);
  }
  if (!body.blueprintId || Number.isNaN(body.blueprintId)) {
    return json({ error: "A blueprint must be selected" }, 400);
  }
  if (!body.variants || Object.keys(body.variants).length === 0) {
    return json({ error: "At least one variant (size/color) must be selected" }, 400);
  }
  if (!body.printProviderId) {
    return json(
      { error: "A print provider must be selected — Printify requires print_provider_id." },
      400,
    );
  }

  const variantIds = Object.values(body.variants).flat();
  if (variantIds.length === 0) {
    return json({ error: "Select at least one size/color variant" }, 400);
  }
  if (variantIds.length > MAX_VARIANTS) {
    return json(
      {
        error: `Printify allows at most ${MAX_VARIANTS} variants per product — ${variantIds.length} were selected. Deselect some and try again.`,
      },
      400,
    );
  }
  const basePrice = typeof body.price === "number" ? body.price : undefined;
  const prices: Record<number, number> = {};
  for (const id of variantIds) {
    prices[id] = Math.round(body.prices?.[id] ?? basePrice ?? 0);
  }
  if (variantIds.some((id) => !(prices[id] > 0))) {
    return json(
      { error: "Set a price (in cents) — Printify requires a price for every selected variant." },
      400,
    );
  }

  try {
    let assetId: string | undefined;
    if (body.artwork) {
      if (base64Bytes(body.artwork.base64) > MAX_UPLOAD_BYTES) {
        return json({ error: "Artwork exceeds the 8 MB upload limit after processing" }, 413);
      }
      const uploaded = await client.uploadImage(body.artwork.base64, body.artwork.filename);
      assetId = String(uploaded.id);
    }

    const printAreas = { ...(body.printAreas ?? {}) };
    if (assetId && body.artwork?.printAreaId) {
      printAreas[body.artwork.printAreaId] = assetId;
    }

    const product = await client.createProduct({
      title: body.title.trim(),
      description: body.description ?? "",
      tags: sanitizeTags(body.tags),
      blueprintId: body.blueprintId,
      printProviderId: body.printProviderId,
      variants: body.variants,
      prices,
      printAreas: Object.keys(printAreas).length > 0 ? printAreas : undefined,
    });

    return json({ product });
  } catch (error) {
    if (error instanceof PrintifyError) {
      const detail =
        error.detail === undefined
          ? undefined
          : (typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail)).slice(0, 400);
      return json({ error: error.message, detail, status: error.status }, 502);
    }
    return json(
      { error: error instanceof Error ? error.message : "Unexpected error creating product" },
      500,
    );
  }
};
