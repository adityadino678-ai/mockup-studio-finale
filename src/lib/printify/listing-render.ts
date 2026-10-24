// ---------------------------------------------------------------------------
// Listing images: render one design onto one mockup, with a fingerprint.
//
// The render itself is the batch engine's `renderComposition`, so a listing
// image and a render produced anywhere else in the app are pixel-identical.
// The fingerprint is what makes "Save & render" cheap on the second run: an
// unchanged design file, mockup, print area and placement produce the same
// string, so the already-stored asset is reused.
//
// `computeRenderFingerprint` is the ONE source of that string. The render-plan
// convenience below uses it, and `renderComposition` stores the value as
// `renderFp` on the render asset's meta — which is what will let the Listing
// images tab ADOPT a render made in the Mockups panel instead of re-rendering
// it.
// ---------------------------------------------------------------------------

import { getPlacement } from "@/lib/db/repo";
import { renderComposition } from "@/lib/batch/runner";
import { printAreaOf } from "@/lib/mockups/print-area";
import { resolveRenderPlan, type RenderPlan } from "@/lib/mockups/render-plan";
import type {
  Design,
  Mockup,
  MockupPrintArea,
  Placement,
  StudioListingRender,
  StudioSession,
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

/**
 * Everything that changes the pixels, and nothing that does not.
 *
 * This is the ONE source of the render fingerprint (version 2): the listing
 * path calls it, `resolveRenderPlanWithFingerprint` calls it, and the value it
 * returns is what `renderComposition` stores as `renderFp` on the asset.
 */
export function computeRenderFingerprint(params: {
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
 * The listing path's original name for `computeRenderFingerprint`, kept as a
 * one-line alias typed off the helper itself so the two can never drift.
 */
export function listingRenderFingerprint(
  params: Parameters<typeof computeRenderFingerprint>[0],
): string {
  return computeRenderFingerprint(params);
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
  return computeRenderFingerprint({
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
 * Resolves the plan AND its fingerprint from ONE snapshot.
 *
 * This lives here rather than in `render-plan.ts` because the import only
 * works one way: this module already imports `resolveRenderPlan`, so the
 * reverse edge would be a cycle. `render-plan.ts` stays pure placement maths.
 *
 * The fingerprint is computed from the plan itself: the plan's area (an
 * `areaOverride` is what actually renders, so it is what gets hashed), the
 * plan's placement, and the RAW `behindMockup` override — the same value the
 * listing path hashes, not the plan's clip-mode default — so both paths agree
 * byte for byte on the same inputs.
 */
export async function resolveRenderPlanWithFingerprint(params: {
  designId: string;
  /** The artwork asset the render composes; hashed into the fingerprint. */
  designAssetId: string;
  mockup: Mockup;
  session?: StudioSession;
  areaOverride?: MockupPrintArea | null;
  placementOverride?: StudioPlacement;
  /** Used only when the mockup has no print area. */
  fallbackTransform?: Transform | null;
  /** Overrides the print area's compositing mode. */
  behindMockup?: boolean | null;
}): Promise<{ plan: RenderPlan; fp: string }> {
  const plan = await resolveRenderPlan({
    designId: params.designId,
    mockup: params.mockup,
    session: params.session,
    areaOverride: params.areaOverride,
    placementOverride: params.placementOverride,
    fallbackTransform: params.fallbackTransform,
    behindMockup: params.behindMockup,
  });

  const fp = computeRenderFingerprint({
    designAssetId: params.designAssetId,
    // The plan's area is the authoritative one: an override (or an explicit
    // `null`) is what the pixels were built from, so it is what is hashed.
    mockup: { ...params.mockup, printArea: plan.area },
    placement: plan.placement,
    // The saved transform is part of the hash ONLY when there is no print
    // area — the same rule `listingImageFingerprint` applies.
    fallbackTransform: plan.area
      ? null
      : (params.fallbackTransform ?? DEFAULT_TRANSFORM),
    behindMockup: params.behindMockup ?? null,
  });

  return { plan, fp };
}

/**
 * Renders one listing image and stores it as a `mockup-render` asset.
 *
 * A mockup with a print area takes the Studio placement through its frame,
 * exactly as the Design panel and the batch engine do. A mockup without one
 * falls back to its saved placement, then the default. The plan and its
 * fingerprint come from ONE snapshot, and the asset records that fingerprint
 * as `renderFp`, so a render made here can be recognised again by its meta.
 */
export async function renderListingMockup(params: {
  listing: StudioListing;
  design: Design;
  mockup: Mockup;
  placement: StudioPlacement;
}): Promise<{ assetId: string; fingerprint: string }> {
  const designAssetId = params.listing.artworkAssetId;
  const saved = await getPlacement(params.design.id, params.mockup.id);
  const { plan, fp } = await resolveRenderPlanWithFingerprint({
    designId: params.design.id,
    designAssetId,
    mockup: params.mockup,
    placementOverride: params.placement,
    fallbackTransform: saved?.transform ?? DEFAULT_TRANSFORM,
    behindMockup: saved?.behindMockup,
  });

  const assetId = await renderComposition({
    designId: params.design.id,
    mockupId: params.mockup.id,
    designAssetId,
    transform: { ...plan.transform },
    clip: plan.clip ?? null,
    behindMockup: plan.behindMockup,
    renderFp: fp,
  });

  return { assetId, fingerprint: fp };
}
