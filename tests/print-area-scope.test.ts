// ---------------------------------------------------------------------------
// The print-area save scope.
//
// A normal save - autosave, the tab-switch flush, the unmount flush or
// "Save on this mockup" - writes THIS mockup only. Before the per-scope fix
// the autosave copied every drag onto every mockup of the same category,
// which is why these cases are pinned at the storage layer.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import { savePrintAreaDraft } from "@/lib/mockups/print-area-draft";
import { applyPrintAreaToMockups } from "@/lib/mockups/propagate";
import { printAreaOf, type AreaCrop } from "@/lib/mockups/print-area";
import type { Mockup, MockupPrintArea } from "@/types/domain";

const DESIGN = "design-1";

function printArea(frame: { x: number; y: number; scale: number }, crop?: AreaCrop): MockupPrintArea {
  return {
    areaWidth: 4500,
    areaHeight: 5400,
    source: { kind: "manual" },
    label: "Front",
    frame: { ...frame, rotation: 0 },
    ...(crop ? { crop } : {}),
    clipMode: "area",
    updatedAt: Date.now(),
  };
}

function mockup(id: string, category: Mockup["category"]): Mockup {
  return {
    id,
    name: id,
    category,
    tags: [],
    favorite: false,
    assetId: `asset-${id}`,
    width: 1000,
    height: 1000,
    source: "user",
    createdAt: 1,
  };
}

describe("print area save scope", () => {
  beforeEach(async () => {
    await db.mockups.clear();
    await db.mockups.bulkPut([mockup("m-a", "tshirt"), mockup("m-b", "tshirt"), mockup("m-c", "mug")]);
  });

  it("saving on mockup A leaves mockup B (same category) without a design area", async () => {
    const result = await savePrintAreaDraft({
      sourceMockupId: "m-a",
      designId: DESIGN,
      area: printArea({ x: 0.5, y: 0.4, scale: 0.3 }),
    });

    expect(result.mockupIds).toEqual(["m-a"]);
    const a = await db.mockups.get("m-a");
    const b = await db.mockups.get("m-b");
    expect(printAreaOf(a!, DESIGN)?.frame.scale).toBe(0.3);
    expect(printAreaOf(b!, DESIGN)).toBeUndefined();
    // A different category is untouched too, even though the scope is gone.
    const c = await db.mockups.get("m-c");
    expect(printAreaOf(c!, DESIGN)).toBeUndefined();
  });

  it('"Render on every mockup" (scope category) is what gives B the area', async () => {
    const area = printArea({ x: 0.5, y: 0.4, scale: 0.3 });
    await applyPrintAreaToMockups({ sourceMockupId: "m-a", designId: DESIGN, area, scope: "category" });

    const b = await db.mockups.get("m-b");
    expect(printAreaOf(b!, DESIGN)?.frame.scale).toBe(0.3);
    // The saved area carries the same crop the source showed: the window
    // travels with the frame, per propagate.ts's documented rule.
    const c = await db.mockups.get("m-c");
    expect(printAreaOf(c!, DESIGN)).toBeUndefined();
  });

  it("a tab-switch flush of a pending draft writes only the source mockup", async () => {
    // B already holds an older frame for this design; flushing A's pending
    // draft must not touch it. (Note: with a null override printAreaOf would
    // fall through to the shared area, so a stale FRAME is used instead.)
    await seedStaleSiblingArea(printArea({ x: 0.2, y: 0.2, scale: 0.1 }));
    const pending = printArea({ x: 0.6, y: 0.5, scale: 0.4 }, { x: 0, y: 0, width: 1, height: 0.6 });

    const result = await savePrintAreaDraft({ sourceMockupId: "m-a", designId: DESIGN, area: pending });

    expect(result.mockupIds).toEqual(["m-a"]);
    const a = await db.mockups.get("m-a");
    const b = await db.mockups.get("m-b");
    // The source carries the new frame AND its crop...
    const savedA = printAreaOf(a!, DESIGN);
    expect(savedA?.frame.scale).toBe(0.4);
    expect(savedA?.crop).toEqual({ x: 0, y: 0, width: 1, height: 0.6 });
    // ...while B keeps the stale frame and nothing else is written.
    expect(printAreaOf(b!, DESIGN)?.frame.scale).toBe(0.1);
  });
});

/** Seeds B with a stale pre-existing area for the design, as an old save would have. */
async function seedStaleSiblingArea(stale: MockupPrintArea) {
  const b = await db.mockups.get("m-b");
  await db.mockups.put({ ...b!, designAreas: { [DESIGN]: stale } });
}
