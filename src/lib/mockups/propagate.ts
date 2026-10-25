// ---------------------------------------------------------------------------
// Applying one print area to many mockups.
//
// A print area is a frame stored as fractions of the PHOTO. The frame belongs
// to the photo, so the default is to save it on that mockup only. Copying it to
// same-type or all mockups is an explicit choice; it is never automatic and a
// new mockup never inherits a sibling's frame.
//
// The frame is stored PER DESIGN: the shared `printArea` is the default a
// design starts from, and every design that edits it gets its own entry in
// `designAreas`. A scoped save therefore copies THIS design's override to the
// targets and leaves the shared default and the other designs' overrides
// untouched. Without a `designId` the call keeps the old base behaviour.
//
// The frame travels when copying, and the CROP travels with it: the visible
// window is part of the staged pose - what the frame shows is one decision
// with where the frame sits, so a copy that kept the target's old window
// would put the new frame behind the wrong fold. What does NOT travel is the
// garment reference (the inches measurement): it describes the photo's real
// scale, so a folded shirt and a flat-lay keep their own unless the caller
// explicitly asks to copy it.
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
 * With `designId`, the write is this design's override: every target gets
 * `designAreas[designId] = area` and its shared `printArea` is left alone.
 * Other designs' overrides are preserved. Without it, the old behaviour
 * writes the shared `printArea` (for any legacy caller).
 *
 * `copyCrop` defaults to true: the crop follows the frame, so every target
 * receives the window the user just staged (and the whole area when the draft
 * has none). `copyReference` defaults to false: the inches measurement is a
 * property of the photo, not of the frame. Both use the DESIGN-specific
 * previous area, so a copy never inherits another design's window.
 */
export async function applyPrintAreaToMockups(params: {
  sourceMockupId: string;
  area: MockupPrintArea;
  scope: PrintAreaScope;
  designId?: string;
  copyCrop?: boolean;
  copyReference?: boolean;
}): Promise<{ updated: number; mockupIds: string[] }> {
  const copyCrop = params.copyCrop ?? true;
  const copyReference = params.copyReference ?? false;
  const designId = params.designId;
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
      // `previous` is the DESIGN's area, never another design's: the crop and
      // reference rules below are about what this design had on this photo.
      const previous = printAreaOf(existing, designId);
      const isSource = existing.id === params.sourceMockupId;
      const next: MockupPrintArea = {
        ...params.area,
        frame: { ...params.area.frame },
        // The crop follows the frame: a sibling receives the window the user
        // just staged (or the whole area when the draft has none) instead of
        // keeping a window that fit the old frame. The reference stays per
        // photo unless the caller explicitly asks to copy it.
        crop:
          copyCrop || isSource
            ? params.area.crop
              ? { ...params.area.crop }
              : undefined
            : previous?.crop,
        reference:
          copyReference || isSource
            ? params.area.reference
              ? { ...params.area.reference }
              : undefined
            : previous?.reference,
        updatedAt: now,
      };
      if (designId) {
        await db.mockups.put({
          ...existing,
          designAreas: { ...existing.designAreas, [designId]: next },
        });
      } else {
        await db.mockups.put({ ...existing, printArea: next });
      }
      written.push(existing.id);
    }
  });

  return { updated: written.length, mockupIds: written };
}
