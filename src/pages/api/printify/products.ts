import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { createPrintifyClient, PrintifyError } from "@/lib/server/printify";
import { clampPlacement } from "@/lib/printify/fit";

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
  /**
   * One entry per artwork group. `variantIds` decides which colours the
   * artwork is printed on, so one design can carry different artwork for
   * different colours of the same product. The groups must partition the
   * enabled variants - see AGENTS.md.
   */
  artworks?: Array<{
    /** Print area position, e.g. "front". */
    printAreaId: string;
    /** The variants this artwork is printed on. Defaults to every variant. */
    variantIds?: number[];
    base64: string;
    filename: string;
    /** Placement inside the print area, in Printify's centre-based units. */
    placement?: { x?: number; y?: number; scale?: number; angle?: number };
  }>;
}

/**
 * Keep well under the Workers memory ceiling. A 25 MB base64 body plus its
 * decoded buffer can exceed the 128 MB limit; the client downscales artwork to
 * stay under this cap before uploading.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling for the whole request. A product can carry several artwork groups
 * (one per colour), and each one is a separate base64 payload, so the
 * per-artwork cap alone is not enough to bound the request.
 */
const MAX_TOTAL_UPLOAD_BYTES = 24 * 1024 * 1024;

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
 * buffer. `Buffer` does not exist in the Workers runtime, and decoding 8 MB
 * just to measure it would double the peak memory for no reason.
 *
 * The string is scanned in place: a `data:` prefix, whitespace and padding
 * are skipped rather than copied out, because the payload can be 10 MB and
 * three copies of it would dominate the request's memory.
 */
function base64Bytes(base64: string): number {
  let start = 0;
  if (base64.startsWith("data:")) {
    const comma = base64.indexOf(",");
    if (comma >= 0) start = comma + 1;
  }
  let length = 0;
  for (let i = start; i < base64.length; i++) {
    const code = base64.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) continue; // whitespace
    if (code === 61) break; // '=' padding ends the payload
    length++;
  }
  return Math.floor((length * 3) / 4);
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
    // --- artwork -------------------------------------------------------------
    // `artworks` is the multi-group form: one upload per artwork group, each
    // with the variants it prints on. The legacy single `artwork` form is
    // still accepted and applies its image to every variant.
    const artworks: NonNullable<CreateProductBody["artworks"]> = body.artworks ?? (body.artwork ? [{ ...body.artwork }] : []);
    if (artworks.length === 0) {
      return json({ error: "Attach a design to a print area before creating the product" }, 400);
    }

    const totalBytes = artworks.reduce((sum, a) => sum + base64Bytes(a.base64), 0);
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      return json(
        {
          error: `The artwork for this product is too large (${Math.round(totalBytes / 1024 / 1024)} MB). Use smaller or fewer designs.`,
        },
        413,
      );
    }

    const printAreaGroups: Array<{
      variantIds: number[];
      position: string;
      imageId: string;
      x?: number;
      y?: number;
      scale?: number;
      angle?: number;
    }> = [];

    for (const artwork of artworks) {
      if (base64Bytes(artwork.base64) > MAX_UPLOAD_BYTES) {
        return json({ error: "Artwork exceeds the 8 MB upload limit after processing" }, 413);
      }
      const uploaded = await client.uploadImage(artwork.base64, artwork.filename);
      const placement = clampPlacement(artwork.placement ?? {});
      printAreaGroups.push({
        variantIds: artwork.variantIds?.length ? artwork.variantIds : variantIds,
        position: artwork.printAreaId,
        imageId: String(uploaded.id),
        x: placement.x,
        y: placement.y,
        scale: placement.scale,
        angle: placement.angle,
      });
    }

    // A product's print areas must partition its variants. Printify rewrites
    // a group to swallow anything nobody named, and a variant that lands in
    // the wrong group is printed with the wrong artwork.
    const covered = new Set<number>();
    for (const group of printAreaGroups) {
      for (const id of group.variantIds) {
        if (covered.has(id)) {
          return json(
            { error: `Variant ${id} is assigned to more than one print area. Every variant must belong to exactly one.` },
            400,
          );
        }
        covered.add(id);
      }
    }
    const uncovered = variantIds.filter((id) => !covered.has(id));
    if (uncovered.length > 0) {
      return json(
        {
          error: `${uncovered.length} variant(s) have no artwork. Every selected variant must belong to a print area, or Printify will print the wrong design on it.`,
        },
        400,
      );
    }

    // Resolve the shop once per request: the response carries it so the
    // mockup bridge can address the same product without guessing.
    const shopId = await client.resolveShopId();
    const product = await client.createProduct({
      title: body.title.trim(),
      description: body.description ?? "",
      tags: sanitizeTags(body.tags),
      blueprintId: body.blueprintId,
      printProviderId: body.printProviderId,
      variants: body.variants,
      prices,
      printAreaGroups,
      shopId,
    });

    // The uploaded image ids are echoed back so the client can VERIFY that
    // every enabled variant really carries the artwork it was meant to.
    return json({
      product,
      shopId,
      artworks: printAreaGroups.map((g) => ({
        printAreaId: g.position,
        variantIds: g.variantIds,
        imageId: g.imageId,
      })),
    });
  } catch (error) {
    if (error instanceof PrintifyError) {
      const detail =
        error.detail === undefined
          ? undefined
          : (typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail)).slice(0, 400);
      // Pass the upstream status through where it is meaningful, so a
      // validation failure is not reported to the browser as a gateway error.
      const status =
        error.status === 429
          ? 429
          : error.status === 400 || error.status === 422 || error.status === 413
            ? 400
            : error.status === 404
              ? 404
              : 502;
      return json({ error: error.message, detail, status: error.status }, status);
    }
    return json(
      { error: error instanceof Error ? error.message : "Unexpected error creating product" },
      500,
    );
  }
};
