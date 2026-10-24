// ---------------------------------------------------------------------------
// Applying one print area to many mockups.
//
// A print area is a frame stored as fractions of the PHOTO. The frame belongs
// to the photo, so the default is to save it on that mockup only. Copying it to
// same-type or all mockups is an explicit choice; it is never automatic and a
// new mockup never inherits a sibling's frame.
//
// Only the geometry that defines the placement travels when copying:
//   area size, frame, source, label, clip mode.
// The photo-specific bits (the crop window and the garment reference) stay on
// each mockup unless the caller explicitly asks to copy them, because a folded
// shirt and a flat-lay need different windows even though the design sits in
// the same place.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db/schema";
import { printAreaOf } from "@/lib/mockups/print-area";
import type { Mockup, MockupPrintArea } from "@/types/domain";

export type PrintAreaScope = "this" | "category" | "all";

/** A short label for the scope, used by the panel. */
export function printAreaScopeLabel(scope: PrintAreaScope): string {
  if (scope === "this") return "This mockup only";
  if (scope === "all") return "All mockups";
  return "All mockups of this type";
}

/** The mockups a save should touch. Never includes a mockup without an id. */
export function printAreaScopeTargets(
  mockups: readonly Mockup[],
  source: Mockup,
  scope: PrintAreaScope,
): Mockup[] {
  if (scope === "this") return [source];
  if (scope === "all") return [...mockups];
  return mockups.filter((m) => m.category === source.category);
}

/**
 * Writes `area` to every mockup in `scope` in ONE transaction.
 *
 * `copyCrop` and `copyReference` default to false: the frame is portable, the
 * visible window and the inches measurement are properties of the photo.
 */
export async function applyPrintAreaToMockups(params: {
  sourceMockupId: string;
  area: MockupPrintArea;
  scope: PrintAreaScope;
  copyCrop?: boolean;
  copyReference?: boolean;
}): Promise<{ updated: number; mockupIds: string[] }> {
  const source = await db.mockups.get(params.sourceMockupId);
  if (!source) return { updated: 0, mockupIds: [] };
  const all = await db.mockups.toArray();
  const targets = printAreaScopeTargets(all, source, params.scope);
  const now = Date.now();
  const written: string[] = [];

  await db.transaction("rw", db.mockups, async () => {
    for (const target of targets) {
      const existing = await db.mockups.get(target.id);
      if (!existing) continue;
      const previous = printAreaOf(existing);
      const isSource = existing.id === params.sourceMockupId;
      const next: MockupPrintArea = {
        ...params.area,
        frame: { ...params.area.frame },
        // The source's own crop/reference are the draft the user just edited;
        // a sibling keeps its own photo-specific window.
        crop:
          params.copyCrop || isSource
            ? params.area.crop
              ? { ...params.area.crop }
              : undefined
            : previous?.crop,
        reference:
          params.copyReference || isSource
            ? params.area.reference
              ? { ...params.area.reference }
              : undefined
            : previous?.reference,
        updatedAt: now,
      };
      await db.mockups.put({ ...existing, printArea: next });
      written.push(existing.id);
    }
  });

  return { updated: written.length, mockupIds: written };
}
