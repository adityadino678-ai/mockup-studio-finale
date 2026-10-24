import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import { emptySession } from "@/lib/printify/studio-session";
import { clipFor, mapStudioPlacement } from "@/lib/mockups/print-area";
import {
  applyPrintAreaToMockups,
  inheritedPrintArea,
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
    const session = { ...emptySession(), universal: true, universalPlacement: placement(0.5) };

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
    const session = { ...emptySession(), universal: true, universalPlacement: placement(0.7) };

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
    const session = { ...emptySession(), universal: true, universalPlacement: placement(0.5) };
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

describe("writeStudioPlacement", () => {
  it("respects the session's universal mode instead of forcing per-design", async () => {
    const base = {
      ...emptySession(),
      universal: true,
      universalPlacement: placement(0.4),
    };

    const next = await writeStudioPlacement("d1", placement(0.8, 15), {
      session: base,
      scope: "auto",
    });

    expect(next.universal).toBe(true);
    expect(next.universalPlacement).toEqual(placement(0.8, 15));
    expect(next.placements.d1).toBeUndefined();
  });

  it("writes a per-design override when the scope says this design", async () => {
    const base = {
      ...emptySession(),
      universal: true,
      universalPlacement: placement(0.4),
    };

    const next = await writeStudioPlacement("d1", placement(0.9, -10), {
      session: base,
      scope: "design",
    });

    expect(next.universal).toBe(false);
    expect(next.placements.d1).toEqual(placement(0.9, -10));
    // The old universal placement remains the fallback for other designs.
    expect(next.universalPlacement).toEqual(placement(0.4));
  });
});

describe("print-area propagation", () => {
  it("targets the same category by default and can target all mockups", () => {
    const source = mockup("m1", "tshirt", area());
    const sameType = mockup("m2", "tshirt", area());
    const other = mockup("m3", "mug", area());
    const all = [source, sameType, other];

    expect(printAreaScopeTargets(all, source, "category").map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(printAreaScopeTargets(all, source, "all").map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(printAreaScopeTargets(all, source, "this").map((m) => m.id)).toEqual(["m1"]);
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

  it("inherits the most recently updated sibling area for an empty mockup", () => {
    const older = mockup("m1", "tshirt", area({ updatedAt: 1, areaWidth: 1000 }));
    const newer = mockup(
      "m2",
      "tshirt",
      area({ updatedAt: 9, areaWidth: 1400 }),
    );
    const empty = mockup("m3", "tshirt");
    const inherited = inheritedPrintArea(empty, [older, newer, empty]);

    expect(inherited?.areaWidth).toBe(1400);
    // The result is a copy, not a shared reference.
    inherited!.frame.x = 0.1;
    expect(newer.printArea?.frame.x).toBe(0.5);
  });
});
