// ---------------------------------------------------------------------------
// One render plan, used by every entry point.
//
// The preview, Save render, the batch engine, listing renders and the agent
// all used to resolve pieces of this themselves. That is how the mockups panel
// could show one frame while `renderComposition` clipped with another.
//
// `resolveRenderPlan` takes ONE mockup snapshot and returns the placement, the
// transform AND the clip derived from that same snapshot. Callers hand the
// whole plan to the compositor, so there is no second read of the database
// between the preview maths and the pixels.
// ---------------------------------------------------------------------------

import { loadSession, placementFor } from "@/lib/printify/studio-session";
import {
  clipFor,
  mapStudioPlacement,
  printAreaOf,
  type RotatedRect,
} from "@/lib/mockups/print-area";
import {
  DEFAULT_TRANSFORM,
  type Mockup,
  type MockupPrintArea,
  type StudioPlacement,
  type StudioSession,
  type Transform,
} from "@/types/domain";

export interface RenderPlan {
  /** The print area the plan used. Undefined when the mockup has none. */
  area?: MockupPrintArea;
  /** The Studio placement for the design. */
  placement: StudioPlacement;
  /** The design's transform in mockup pixels (normalised). */
  transform: Transform;
  /** The clip region, when the mockup has a print area. */
  clip?: RotatedRect;
  /** Draw the design under a transparent mockup PNG. */
  behindMockup: boolean;
}

/**
 * Resolves one design on one mockup from a single snapshot.
 *
 * `areaOverride` is what the Mockups panel passes: the unsaved draft the user
 * is looking at. `undefined` means "use the mockup's stored area"; `null` means
 * "pretend this mockup has no area". That distinction is deliberate - it lets
 * a caller render the exact frame on screen without saving it first.
 *
 * `placementOverride` is for the listing path, which already has the listing
 * owner's placement and must not re-read a possibly different design.
 */
export async function resolveRenderPlan(params: {
  designId: string;
  mockup: Mockup;
  session?: StudioSession;
  areaOverride?: MockupPrintArea | null;
  placementOverride?: StudioPlacement;
  /** Used only when the mockup has no print area. */
  fallbackTransform?: Transform | null;
  /** Overrides the print area's compositing mode. */
  behindMockup?: boolean | null;
}): Promise<RenderPlan> {
  const placement =
    params.placementOverride ??
    placementFor(
      params.session ?? (await loadSession()),
      params.designId,
    );

  const area =
    params.areaOverride !== undefined
      ? (params.areaOverride ?? undefined)
      : printAreaOf(params.mockup);

  if (!area) {
    return {
      placement,
      transform: params.fallbackTransform
        ? { ...params.fallbackTransform }
        : { ...DEFAULT_TRANSFORM },
      behindMockup: params.behindMockup ?? false,
    };
  }

  const transform = mapStudioPlacement(
    placement,
    area,
    area.frame,
    params.mockup.width,
    params.mockup.height,
  );

  return {
    area,
    placement,
    transform,
    clip: clipFor(area, area.frame, params.mockup.width, params.mockup.height),
    behindMockup:
      params.behindMockup ?? area.clipMode === "behind-garment",
  };
}
