// ---------------------------------------------------------------------------
// Where does a design sit on a garment?
//
// One rule, used everywhere:
//
//   A mockup WITH a print area  -> the Printify Studio's placement, mapped
//                                  into the mockup and clipped to the area.
//   A mockup WITHOUT one         -> the saved placement, the batch's
//                                  placement template, or the default.
//
// The Studio is the single source of truth for a design's placement, so the
// mockup the buyer sees and the product Printify prints cannot disagree.
// ---------------------------------------------------------------------------

import { loadSession, placementFor, saveSession } from "@/lib/printify/studio-session";
import { mapStudioPlacement, studioPlacementFromTransform } from "@/lib/mockups/print-area";
import type {
  Mockup,
  MockupPrintArea,
  StudioPlacement,
  StudioSession,
  Transform,
} from "@/types/domain";

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
 * Returns null when the mockup has no area, or when the artwork's size is
 * unknown - in both cases the caller falls back to its own rules.
 */
export async function transformFromPrintArea(params: {
  designId: string;
  mockup: Mockup;
  session?: StudioSession;
}): Promise<Transform | null> {
  const area = params.mockup.printArea;
  if (!area) return null;
  const placement = await studioPlacementForDesign(params.designId, params.session);
  return mapStudioPlacement(
    placement,
    area,
    area.box,
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
 * The Studio placement for a transform the user dragged in the mockups tab.
 *
 * The inverse of `mapStudioPlacement`, so the numbers that go back into the
 * Studio are exactly the ones the preview was drawn from.
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
    params.area.box,
    params.mockupW,
    params.mockupH,
    params.position,
  );
}
