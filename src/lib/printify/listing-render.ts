// ---------------------------------------------------------------------------
// Listing images: render one design onto one mockup, with a fingerprint.
//
// The render itself is the batch engine's `renderComposition`, so a listing
// image and a render produced anywhere else in the app are pixel-identical.
// The fingerprint is what makes "Save & render" cheap on the second run: an
// unchanged design file, mockup, print area and placement produce the same
// string, so the already-stored asset is reused.
// ---------------------------------------------------------------------------

import { getPlacement } from "@/lib/db/repo";
import { renderComposition } from "@/lib/batch/runner";
import {
  mapStudioPlacement,
  printAreaOf,
} from "@/lib/mockups/print-area";
import type {
  Design,
  Mockup,
  Placement,
  StudioListingRender,
  StudioPlacement,
  Transform,
} from "@/types/domain";
import { DEFAULT_TRANSFORM } from "@/types/domain";
import type { StudioListing } from "@/lib/printify/listing-plan";

export function listingRenderKey(listingId: string, mockupId: string): string {
  return `${listingId}:${mockupId}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Everything that changes the pixels, and nothing that does not. */
export function listingRenderFingerprint(params: {
  designAssetId: string;
  mockup: Pick<Mockup, "assetId" | "width" | "height" | "printArea">;
  placement: StudioPlacement;
  /**
   * The saved mockup placement, used only when the mockup has NO print area.
   * A print area maps the Studio placement through its frame, so the saved
   * transform is not an input there.
   */
  fallbackTransform?: Transform | null;
  /** Overrides the print area's behind-garment mode when the user set one. */
  behindMockup?: boolean | null;
}): string {
  const area = printAreaOf(params.mockup);
  return JSON.stringify(
    stableValue({
      version: 2,
      designAssetId: params.designAssetId,
      mockup: {
        assetId: params.mockup.assetId,
        width: params.mockup.width,
        height: params.mockup.height,
        // Only pixel-affecting print-area fields. `label`, `source`,
        // `reference` and `updatedAt` change without changing the render.
        printArea: area
          ? {
              areaWidth: area.areaWidth,
              areaHeight: area.areaHeight,
              frame: area.frame,
              crop: area.crop ?? null,
              clipMode: area.clipMode,
            }
          : null,
      },
      placement: {
        x: params.placement.x,
        y: params.placement.y,
        scale: params.placement.scale,
        angle: params.placement.angle,
      },
      fallbackTransform: params.fallbackTransform ?? null,
      behindMockup: params.behindMockup ?? null,
    }),
  );
}

/**
 * The fingerprint for one listing image, with the saved-transform fallback
 * applied exactly the way `renderListingMockup` applies it.
 */
export function listingImageFingerprint(params: {
  listing: StudioListing;
  mockup: Pick<Mockup, "assetId" | "width" | "height" | "printArea">;
  placement: StudioPlacement;
  saved?: Pick<Placement, "transform" | "behindMockup"> | null;
}): string {
  const area = printAreaOf(params.mockup);
  return listingRenderFingerprint({
    designAssetId: params.listing.artworkAssetId,
    mockup: params.mockup,
    placement: params.placement,
    fallbackTransform: area ? null : (params.saved?.transform ?? DEFAULT_TRANSFORM),
    behindMockup: params.saved?.behindMockup ?? null,
  });
}

export function isListingRenderFresh(
  entry: StudioListingRender | undefined,
  fingerprint: string,
): boolean {
  return !!entry && entry.fingerprint === fingerprint;
}

/**
 * Renders one listing image and stores it as a `mockup-render` asset.
 *
 * A mockup with a print area takes the Studio placement through its frame,
 * exactly as the Design panel and the batch engine do. A mockup without one
 * falls back to its saved placement, then the default.
 */
export async function renderListingMockup(params: {
  listing: StudioListing;
  design: Design;
  mockup: Mockup;
  placement: StudioPlacement;
}): Promise<{ assetId: string; fingerprint: string }> {
  const designAssetId = params.listing.artworkAssetId;
  const area = printAreaOf(params.mockup);
  const saved = await getPlacement(params.design.id, params.mockup.id);
  const fingerprint = listingImageFingerprint({
    listing: params.listing,
    mockup: params.mockup,
    placement: params.placement,
    saved,
  });

  const transform = area
    ? mapStudioPlacement(
        params.placement,
        area,
        area.frame,
        params.mockup.width,
        params.mockup.height,
      )
    : (saved?.transform ?? DEFAULT_TRANSFORM);

  const assetId = await renderComposition({
    designId: params.design.id,
    mockupId: params.mockup.id,
    designAssetId,
    transform: { ...transform },
    // `undefined` lets a print area's behind-garment mode apply; an explicit
    // saved placement still wins when the user chose one for this mockup.
    behindMockup: saved?.behindMockup,
  });

  return { assetId, fingerprint };
}
