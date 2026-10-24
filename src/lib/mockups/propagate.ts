// ---------------------------------------------------------------------------
// Applying one print area to many mockups.
//
// A print area is a frame stored as fractions of the PHOTO, so the same frame
// means the same relative spot on every photo. The user's rule is "place it on
// one mockup, and every mockup of that product type gets it" - this module is
// that rule.
//
// Only the geometry that defines the placement travels:
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
 * The area a mockup with no area of its own should start from.
 *
 * It picks the most recently updated sibling in the same category. This is
 * what makes a newly uploaded mockup show the same placement immediately
 * instead of a blank panel - and it is only a draft until it is saved.
 */
export function inheritedPrintArea(
  mockup: Mockup,
  mockups: readonly Mockup[],
): MockupPrintArea | null {
  if (printAreaOf(mockup)) return null;
  const siblings = mockups
    .filter((m) => m.id !== mockup.id && m.category === mockup.category)
    .map((m) => ({ mockup: m, area: printAreaOf(m) }))
    .filter((entry): entry is { mockup: Mockup; area: MockupPrintArea } => !!entry.area)
    .sort((a, b) => (b.area.updatedAt ?? 0) - (a.area.updatedAt ?? 0));
  const source = siblings[0]?.area;
  if (!source) return null;
  return {
    ...source,
    frame: { ...source.frame },
    crop: source.crop ? { ...source.crop } : undefined,
    reference: source.reference ? { ...source.reference } : undefined,
    updatedAt: Date.now(),
  };
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
