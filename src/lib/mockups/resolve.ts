// ---------------------------------------------------------------------------
// Where does a design sit on a garment?
//
// One rule, used everywhere:
//
//   A mockup WITH a print area  -> the Printify Studio's placement, carried
//                                  by the mockup's frame and clipped to it.
//   A mockup WITHOUT one         -> the saved placement, the batch's
//                                  placement template, or the default.
//
// The Studio is the single source of truth for a design's placement, so the
// mockup the buyer sees and the product Printify prints cannot disagree.
// ---------------------------------------------------------------------------

import { loadSession, placementFor, saveSession } from "@/lib/printify/studio-session";
import { mapStudioPlacement, printAreaOf, studioPlacementFromTransform } from "@/lib/mockups/print-area";
import type { Mockup, MockupPrintArea, StudioPlacement, StudioSession, Transform } from "@/types/domain";

/** The Studio placement that applies to a design. */
export async function studioPlacementForDesign(
  designId: string,
  session?: StudioSession,
): Promise<StudioPlacement> {
  const active = session ?? (await loadSession());
  return placementFor(active, designId);
}

/**
 * The transform for a design on a mockup, when the mockup has a print area.
 *
 * The frame's own transform is included: the design is carried by it.
 *
 * Returns null when the mockup has no area - in that case the caller falls
 * back to its own rules.
 */
export async function transformFromPrintArea(params: {
  designId: string;
  mockup: Mockup;
  session?: StudioSession;
}): Promise<Transform | null> {
  const area = printAreaOf(params.mockup);
  if (!area) return null;
  const placement = await studioPlacementForDesign(params.designId, params.session);
  return mapStudioPlacement(
    placement,
    area,
    area.frame,
    params.mockup.width,
    params.mockup.height,
  );
}

/**
 * Writes a placement back into the Studio session, for one design.
 *
 * It always lands as a PER-DESIGN override and turns the universal placement
 * off, because a universal placement is a different thing: it is the
 * placement for every design at once. Editing one design must not silently
 * move the rest.
 */
export async function writeBackStudioPlacement(
  designId: string,
  placement: StudioPlacement,
  session?: StudioSession,
): Promise<StudioSession> {
  const active = session ?? (await loadSession());
  const next: StudioSession = {
    ...active,
    universal: false,
    placements: { ...active.placements, [designId]: placement },
    updatedAt: Date.now(),
  };
  await saveSession(next);
  return next;
}

/**
 * The Studio placement for a transform the user dragged in the editor.
 *
 * The inverse of `mapStudioPlacement`, so the numbers that go back into the
 * Studio are exactly the ones the preview was drawn from - the frame's own
 * rotation and scale are taken back off.
 */
export function placementForTransform(params: {
  transform: Transform;
  area: MockupPrintArea;
  mockupW: number;
  mockupH: number;
  position: string;
}): StudioPlacement {
  return studioPlacementFromTransform(
    params.transform,
    params.area,
    params.area.frame,
    params.mockupW,
    params.mockupH,
    params.position,
  );
}
