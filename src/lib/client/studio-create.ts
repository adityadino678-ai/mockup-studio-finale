"use client";

// ---------------------------------------------------------------------------
// Creating Printify products from a Studio plan.
//
// This used to live inside the Design panel's click handler. The listing
// autopilot needs the exact same contract - one product per plan item, a
// COMPLETE variant partition, the artwork sized to the print area, and a
// post-create check that Printify attached the right artwork - so the loop
// lives here and both callers share it.
//
// Nothing here publishes. A created product is an unpublished Printify draft;
// publishing stays the explicit, review-gated step in the Listing preview or
// the autopilot's final approval.
// ---------------------------------------------------------------------------

import { artworkToBase64Sized } from "@/lib/client/artwork";
import { authedFetch } from "@/lib/client/integrations";
import { getAssetBlob, logActivity, uid } from "@/lib/db/repo";
import { db } from "@/lib/db/schema";
import { clampPlacement } from "@/lib/printify/fit";
import {
  placementFor,
  priceForListing,
  renderTemplate,
  renderTitle,
} from "@/lib/printify/studio-session";
import type { StudioDesignPlan, StudioPlan } from "@/lib/printify/studio-plan";
import { buildPartition, resolveVariantIds } from "@/lib/printify/variants";
import type { StudioProductResult, StudioSession } from "@/types/domain";

export interface StudioCreateOverrides {
  title?: string;
  description?: string;
  tags?: string[];
  priceCents?: number;
}

export interface StudioCreateContext {
  session: StudioSession;
  plan: StudioPlan;
  /** The blueprint's display name, for `{product}` in the templates. */
  productName: string;
  /** Long edge to size uploaded artwork to; derived from the print area. */
  areaWidth?: number;
  areaHeight?: number;
  /**
   * Per-listing copy. The autopilot writes reviewed copy here so the Printify
   * product carries exactly what the human approved, not a re-expanded
   * template.
   */
  overrides?: StudioCreateOverrides;
}

export interface StudioCreateHooks {
  onProgress?: (item: StudioDesignPlan) => void;
  /** Called after EVERY item, including a failure, so the caller can persist. */
  onResult?: (result: StudioProductResult) => void | Promise<void>;
}

export interface StudioCreateOutcome {
  results: StudioProductResult[];
  created: StudioProductResult[];
  failed: number;
}

function failedResult(
  item: StudioDesignPlan,
  message: string,
  extra: Partial<StudioProductResult> = {},
): StudioProductResult {
  return {
    designId: item.designId,
    title: item.designName,
    designName: item.designName,
    status: "failed",
    error: message,
    createdAt: Date.now(),
    ...extra,
  };
}

/**
 * Creates ONE product from one plan item.
 *
 * API failures become a `failed` result rather than a thrown error, so a batch
 * can continue and the user sees which listing needs attention. A local error
 * (a missing artwork blob, an undecodable file) is also returned as a failure;
 * the product may not exist at all in that case.
 */
export async function createStudioProduct(
  context: StudioCreateContext,
  item: StudioDesignPlan,
): Promise<StudioProductResult> {
  const { session, plan, productName } = context;
  if (!session.blueprintId || !session.printProviderId) {
    return failedResult(item, "Choose a product and print provider in the Studio first.");
  }

  try {
    const partition = buildPartition(
      plan.colourIndex,
      item.groups.map((group) => ({ ink: group.ink, colors: group.colors })),
    );
    // DEBUG: log partition groups to verify ink split
    console.debug("[studio-create] partition groups:", partition.groups.map(g => ({
      ink: g.ink,
      colors: g.colors,
      variantCount: g.variantIds.length,
      variantIds: g.variantIds.slice(0, 5) // first 5 only
    })));
    const enabled = resolveVariantIds(
      plan.colourIndex,
      item.groups.flatMap((group) => group.colors),
      session.sizes,
    );
    console.debug("[studio-create] enabled variant count:", enabled.length, "enabled:", enabled.slice(0, 10));
    if (enabled.length === 0) {
      return {
        designId: item.designId,
        title: item.designName,
        designName: item.designName,
        status: "skipped",
        error: "No variants selected for this design's colours.",
        createdAt: Date.now(),
      };
    }

    // One upload per ink group, sized to the print area so the print is sharp
    // and Printify's resolution check passes.
    const artworks: Array<{
      printAreaId: string;
      variantIds: number[];
      base64: string;
      filename: string;
      placement: { x: number; y: number; scale: number; angle: number };
    }> = [];
    for (let index = 0; index < partition.groups.length; index++) {
      const group = partition.groups[index];
      const artwork = item.groups[index];
      if (!artwork || group.variantIds.length === 0) continue;
      const blob = await getAssetBlob(artwork.assetId);
      if (!blob) throw new Error(`Could not read "${item.designName}" from storage`);
      const longEdge = Math.max(context.areaWidth ?? 3000, context.areaHeight ?? 3000);
      const base64 = await artworkToBase64Sized(blob, longEdge);
      const placement = placementFor(session, item.designId);
      artworks.push({
        printAreaId: placement.position,
        variantIds: group.variantIds,
        base64,
        filename: `${item.designName}-${artwork.ink}.png`,
        placement: clampPlacement(placement),
      });
    }
    console.debug("[studio-create] artworks to Printify:", artworks.map(a => ({
      ink: a.filename,
      variantCount: a.variantIds.length,
      variantIds: a.variantIds.slice(0, 5)
    })));

    const title =
      context.overrides?.title?.trim() ||
      renderTitle(session.titleTemplate, item.designName, productName);
    const description =
      context.overrides?.description ??
      renderTemplate(session.descriptionTemplate, item.designName, productName, "", 5000);
    const tags = context.overrides?.tags ?? session.tags ?? [];
    const price = context.overrides?.priceCents ?? priceForListing(session, item.listingId);

    const response = await authedFetch("/api/printify/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        title,
        description,
        tags,
        blueprintId: session.blueprintId,
        printProviderId: session.printProviderId,
        variants: { [String(session.blueprintId)]: enabled },
        price,
        artworks,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return failedResult(item, data?.error ?? `HTTP ${response.status}`, { title });
    }

    // Verify the product Printify actually built: every enabled variant must
    // sit in the group whose artwork we uploaded for it. The create response
    // carries the whole product, so this costs no extra calls.
    const product = data?.product ?? {};
    const shopId = typeof data?.shopId === "number" ? data.shopId : undefined;
    const uploadedImageByVariant = new Map<number, string>();
    for (const artwork of data?.artworks ?? []) {
      const ids = Array.isArray(artwork.variantIds) ? artwork.variantIds : [];
      for (const variantId of ids) {
        uploadedImageByVariant.set(Number(variantId), String(artwork.imageId));
      }
    }
    const imageByVariant = new Map<number, string>();
    for (const areaEntry of product.print_areas ?? []) {
      for (const placeholder of areaEntry.placeholders ?? []) {
        for (const image of placeholder.images ?? []) {
          for (const variantId of areaEntry.variant_ids ?? []) {
            if (!imageByVariant.has(variantId)) imageByVariant.set(variantId, image.id);
          }
        }
      }
    }
    const wrongArtwork: string[] = [];
    for (const variant of product.variants ?? []) {
      if (!variant.is_enabled) continue;
      const got = imageByVariant.get(variant.id);
      const want = uploadedImageByVariant.get(variant.id);
      if (got && want && got !== want) wrongArtwork.push(String(variant.id));
    }
    if (wrongArtwork.length > 0) {
      return failedResult(
        item,
        `Printify attached the wrong artwork to ${wrongArtwork.length} variant(s). Check the print areas before publishing.`,
        { title, remoteProductId: product.id, shopId },
      );
    }

    // Record the product in the app's own draft table, so the artifact rail
    // and the export can see it even after Printify drops the page.
    const mainAsset = item.groups[0]?.assetId ?? "";
    await db.productDrafts.put({
      id: uid(),
      name: title,
      designId: item.designId,
      designAssetId: mainAsset,
      blueprintId: session.blueprintId,
      printProviderId: session.printProviderId,
      description,
      priceCents: price,
      variantSelection: {},
      printAreaConfig: {},
      status: "created-remote",
      remoteProductId: product.id,
      remoteShopId: shopId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await logActivity("product.create", `Created Printify product "${title}" (${product.id})`, {
      productId: product.id,
      designId: item.designId,
    });

    return {
      designId: item.designId,
      title,
      designName: item.designName,
      status: "created",
      remoteProductId: product.id,
      shopId,
      createdAt: Date.now(),
    };
  } catch (error) {
    return failedResult(
      item,
      error instanceof Error ? error.message : "Could not create the Printify product",
    );
  }
}

/**
 * Creates a batch. Each item is isolated: one bad artwork does not stop the
 * remaining listings, which is what the old single `try` around the whole loop
 * did.
 */
export async function createStudioProducts(
  context: StudioCreateContext,
  items: StudioDesignPlan[],
  hooks: StudioCreateHooks = {},
): Promise<StudioCreateOutcome> {
  const results: StudioProductResult[] = [];
  const created: StudioProductResult[] = [];
  let failed = 0;

  for (const item of items) {
    hooks.onProgress?.(item);
    const result = await createStudioProduct(context, item);
    results.push(result);
    if (result.status === "created") created.push(result);
    if (result.status === "failed") failed++;
    await hooks.onResult?.(result);
  }

  return { results, created, failed };
}
