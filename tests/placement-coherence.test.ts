import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import { emptySession, placementFor } from "@/lib/printify/studio-session";
import { clipFor, mapStudioPlacement } from "@/lib/mockups/print-area";
import {
  applyPrintAreaToMockups,
  printAreaScopeTargets,
} from "@/lib/mockups/propagate";
import { resolveRenderPlan } from "@/lib/mockups/render-plan";
import { writeStudioPlacement } from "@/lib/mockups/resolve";
import type {
  Mockup,
  MockupCategory,
  MockupPrintArea,
  StudioPlacement,
} from "@/types/domain";

const FRAME = { x: 0.5, y: 0.42, scale: 0.32, rotation: 0 };

function area(overrides: Partial<MockupPrintArea> = {}): MockupPrintArea {
  return {
    areaWidth: 1200,
    areaHeight: 1600,
    source: { kind: "preset", presetId: "dtg-front" },
    label: "Front",
    frame: { ...FRAME },
    clipMode: "area",
    updatedAt: 1,
    ...overrides,
  };
}

function mockup(
  id: string,
  category: MockupCategory,
  printArea?: MockupPrintArea,
): Mockup {
  return {
    id,
    name: id,
    category,
    tags: [],
    favorite: false,
    assetId: `asset-${id}`,
    width: 1000,
    height: 1250,
    source: "user",
    printArea,
    createdAt: 1,
  };
}

const placement = (scale: number, angle = 0): StudioPlacement => ({
  position: "front",
  x: 0.5,
  y: 0.5,
  scale,
  angle,
});

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe("resolveRenderPlan", () => {
  it("resolves the transform and the clip from the SAME area snapshot", async () => {
    const printArea = area({
      frame: { x: 0.45, y: 0.4, scale: 0.25, rotation: 9 },
      crop: { x: 0, y: 0, width: 1, height: 0.6 },
    });
    const mock = mockup("m1", "tshirt", printArea);
    const session = { ...emptySession(), universalPlacement: placement(0.5) };

    const plan = await resolveRenderPlan({ designId: "d1", mockup: mock, session });

    expect(plan.area).toEqual(printArea);
    expect(plan.transform).toEqual(
      mapStudioPlacement(placement(0.5), printArea, printArea.frame, mock.width, mock.height),
    );
    expect(plan.clip).toEqual(
      clipFor(printArea, printArea.frame, mock.width, mock.height),
    );
    expect(plan.behindMockup).toBe(false);
  });

  it("honours an unsaved area override for both the transform and the clip", async () => {
    const saved = area();
    const draft = area({
      frame: { x: 0.55, y: 0.5, scale: 0.4, rotation: 0 },
      clipMode: "behind-garment",
    });
    const mock = mockup("m1", "tshirt", saved);
    const session = { ...emptySession(), universalPlacement: placement(0.7) };

    const plan = await resolveRenderPlan({
      designId: "d1",
      mockup: mock,
      session,
      areaOverride: draft,
    });

    expect(plan.area).toEqual(draft);
    expect(plan.transform.x).toBeCloseTo(
      mapStudioPlacement(placement(0.7), draft, draft.frame, mock.width, mock.height).x,
    );
    expect(plan.clip).toEqual(clipFor(draft, draft.frame, mock.width, mock.height));
    expect(plan.behindMockup).toBe(true);
  });

  it("falls back to the saved transform when the mockup has no print area", async () => {
    const mock = mockup("m1", "tshirt");
    const session = { ...emptySession(), universalPlacement: placement(0.5) };
    const fallback = {
      x: 0.25,
      y: 0.35,
      scale: 0.2,
      rotation: 4,
      flipX: false,
      flipY: false,
      opacity: 1,
      stretch: 1,
    };

    const plan = await resolveRenderPlan({
      designId: "d1",
      mockup: mock,
      session,
      fallbackTransform: fallback,
    });

    expect(plan.area).toBeUndefined();
    expect(plan.transform).toEqual(fallback);
    expect(plan.clip).toBeUndefined();
  });
});

describe("placementFor", () => {
  it("gives each design its own placement and uses the shared default when it has none", () => {
    const session = {
      ...emptySession(),
      universalPlacement: placement(0.4),
      placements: { d1: placement(0.9, 12) },
    };

    expect(placementFor(session, "d1")).toEqual(placement(0.9, 12));
    expect(placementFor(session, "d2")).toEqual(placement(0.4));
  });
});

describe("writeStudioPlacement", () => {
  it("writes only the named design by default, never the other designs", async () => {
    const base = {
      ...emptySession(),
      universalPlacement: placement(0.4),
      placements: { d2: placement(0.6) },
    };

    const next = await writeStudioPlacement("d1", placement(0.9, -10), {
      session: base,
    });

    expect(next.placements.d1).toEqual(placement(0.9, -10));
    // The other design keeps its own placement.
    expect(next.placements.d2).toEqual(placement(0.6));
    // The shared default is untouched.
    expect(next.universalPlacement).toEqual(placement(0.4));
    expect(placementFor(next, "d2")).toEqual(placement(0.6));
  });

  it("scope all makes the placement the default and clears stale overrides", async () => {
    const base = {
      ...emptySession(),
      universalPlacement: placement(0.4),
      placements: { d1: placement(0.6), d2: placement(0.7) },
    };

    const next = await writeStudioPlacement("d1", placement(0.85, 15), {
      session: base,
      scope: "all",
    });

    expect(next.placements).toEqual({});
    expect(next.universalPlacement).toEqual(placement(0.85, 15));
    // Every design, including the one with an old override, now uses it.
    expect(placementFor(next, "d1")).toEqual(placement(0.85, 15));
    expect(placementFor(next, "d2")).toEqual(placement(0.85, 15));
  });
});

describe("one design on every mockup", () => {
  it("uses the same design placement on two mockups with different frames", async () => {
    const first = mockup(
      "m1",
      "tshirt",
      area({ frame: { x: 0.5, y: 0.42, scale: 0.32, rotation: 0 } }),
    );
    const second = mockup(
      "m2",
      "tshirt",
      area({ frame: { x: 0.44, y: 0.5, scale: 0.4, rotation: 8 } }),
    );
    const session = {
      ...emptySession(),
      universalPlacement: placement(0.3),
      placements: { d1: placement(0.8, 10), d2: placement(0.4, -5) },
    };

    const a1 = await resolveRenderPlan({ designId: "d1", mockup: first, session });
    const a2 = await resolveRenderPlan({ designId: "d1", mockup: second, session });
    const b1 = await resolveRenderPlan({ designId: "d2", mockup: first, session });
    const b2 = await resolveRenderPlan({ designId: "d2", mockup: second, session });

    // The SAME design uses the same placement on both mockups...
    expect(a1.placement).toEqual(a2.placement);
    expect(a1.placement).toEqual(placementFor(session, "d1"));
    expect(b1.placement).toEqual(b2.placement);
    expect(b1.placement).toEqual(placementFor(session, "d2"));
    // ...while the two designs stay independent.
    expect(a1.placement).not.toEqual(b1.placement);
    // The frames differ, so the mockup-space transforms differ even though the
    // area-space placement is identical.
    expect(a1.transform).not.toEqual(a2.transform);
  });

  it("editing one design leaves the other design's placement alone", async () => {
    const session = {
      ...emptySession(),
      universalPlacement: placement(0.3),
      placements: { d1: placement(0.8), d2: placement(0.4) },
    };

    const next = await writeStudioPlacement("d1", placement(0.55, 20), {
      session,
    });

    expect(placementFor(next, "d2")).toEqual(placement(0.4));
  });
});

describe("print-area propagation", () => {
  it("targets only the scopes the user explicitly chose", () => {
    const source = mockup("m1", "tshirt", area());
    const sameType = mockup("m2", "tshirt", area());
    const other = mockup("m3", "mug", area());
    const all = [source, sameType, other];

    expect(printAreaScopeTargets(all, source, "this").map((m) => m.id)).toEqual(["m1"]);
    expect(printAreaScopeTargets(all, source, "category").map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(printAreaScopeTargets(all, source, "all").map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("saves this mockup only by default and never touches a sibling", async () => {
    const sourceFrame = { x: 0.5, y: 0.42, scale: 0.32, rotation: 0 };
    const siblingFrame = { x: 0.35, y: 0.6, scale: 0.2, rotation: 3 };
    const source = mockup("m1", "tshirt", area({ frame: sourceFrame }));
    const sibling = mockup("m2", "tshirt", area({ frame: siblingFrame }));
    await db.mockups.bulkPut([source, sibling]);

    const draft = area({
      areaWidth: 1500,
      areaHeight: 1800,
      frame: { x: 0.48, y: 0.44, scale: 0.36, rotation: 4 },
      crop: { x: 0, y: 0, width: 1, height: 0.4 },
      updatedAt: 3,
    });

    const result = await applyPrintAreaToMockups({
      sourceMockupId: "m1",
      area: draft,
      scope: "this",
    });

    expect(result.updated).toBe(1);
    expect(result.mockupIds).toEqual(["m1"]);

    const savedSource = (await db.mockups.get("m1"))!;
    const savedSibling = (await db.mockups.get("m2"))!;
    expect(savedSource.printArea?.frame).toEqual(draft.frame);
    expect(savedSource.printArea?.areaWidth).toBe(1500);
    // The sibling's frame belongs to its own photo and was not copied over.
    expect(savedSibling.printArea?.frame).toEqual(siblingFrame);
    expect(savedSibling.printArea?.areaWidth).toBe(1200);
  });

  it("copies the frame to siblings but keeps their own crop and reference", async () => {
    const sourceCrop = { x: 0, y: 0, width: 1, height: 0.55 };
    const siblingCrop = { x: 0.1, y: 0, width: 0.8, height: 1 };
    const source = mockup(
      "m1",
      "tshirt",
      area({ crop: sourceCrop, updatedAt: 1 }),
    );
    const sibling = mockup(
      "m2",
      "tshirt",
      area({
        crop: siblingCrop,
        reference: { label: "Chest", inches: 20, pixelsPerInch: 50 },
        updatedAt: 2,
      }),
    );
    const mug = mockup("m3", "mug", area());
    await db.mockups.bulkPut([source, sibling, mug]);

    const draft = area({
      areaWidth: 1500,
      areaHeight: 1800,
      frame: { x: 0.48, y: 0.44, scale: 0.36, rotation: 4 },
      crop: { x: 0, y: 0, width: 1, height: 0.4 },
      updatedAt: 3,
    });

    const result = await applyPrintAreaToMockups({
      sourceMockupId: "m1",
      area: draft,
      scope: "category",
    });

    expect(result.updated).toBe(2);
    expect(result.mockupIds.sort()).toEqual(["m1", "m2"]);

    const savedSource = (await db.mockups.get("m1"))!;
    const savedSibling = (await db.mockups.get("m2"))!;
    const savedMug = (await db.mockups.get("m3"))!;

    // The source keeps the crop the user just edited...
    expect(savedSource.printArea?.crop).toEqual(draft.crop);
    expect(savedSource.printArea?.frame).toEqual(draft.frame);
    // ...a sibling gets the same frame and size but keeps its own window and
    // reference, because those describe the photo, not the placement.
    expect(savedSibling.printArea?.frame).toEqual(draft.frame);
    expect(savedSibling.printArea?.areaWidth).toBe(1500);
    expect(savedSibling.printArea?.crop).toEqual(siblingCrop);
    expect(savedSibling.printArea?.reference?.inches).toBe(20);
    // The mug is untouched by a t-shirt save.
    expect(savedMug.printArea?.areaWidth).toBe(1200);
  });
});
