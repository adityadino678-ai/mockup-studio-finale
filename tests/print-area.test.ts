import { describe, expect, it } from "vitest";
import {
  areaAspect,
  areaInches,
  clipFor,
  defaultFrame,
  derivePrintAreas,
  designInches,
  frameToPixels,
  mapStudioPlacement,
  normalisePrintArea,
  pixelsPerInch,
  printAreaFromTemplate,
  printAreaTemplateFrom,
  studioPlacementFromTransform,
} from "@/lib/mockups/print-area";
import { presetsForCategory, findPrintAreaPreset, PRINT_AREA_PRESETS } from "@/lib/printify/presets";
import type { MockupPrintArea, StudioPlacement } from "@/types/domain";
import type { CatalogVariant } from "@/lib/printify/types";

/** A 4500 x 5400 DTG area - the one that matters most. */
const AREA = { areaWidth: 4500, areaHeight: 5400 };
/** The frame on the photo: centred, 40% of the width, not rotated. */
const FRAME = { x: 0.5, y: 0.4, scale: 0.4, rotation: 0 };

const placement = (patch: Partial<StudioPlacement> = {}): StudioPlacement => ({
  position: "front",
  x: 0.5,
  y: 0.5,
  scale: 0.5,
  angle: 0,
  ...patch,
});

const area = (patch: Partial<MockupPrintArea> = {}): MockupPrintArea => ({
  areaWidth: AREA.areaWidth,
  areaHeight: AREA.areaHeight,
  source: { kind: "manual" },
  label: "Front",
  frame: FRAME,
  clipMode: "area",
  updatedAt: 0,
  ...patch,
});

describe("the frame on the photo", () => {
  it("keeps the Printify area's aspect, whatever the scale", () => {
    const px = frameToPixels(FRAME, AREA, 3000, 4000);
    expect(px.width).toBeCloseTo(1200);
    // 5400/4500 = 1.2 - the frame is 1.2 times as tall as it is wide.
    expect(px.height).toBeCloseTo(1440);
    expect(px.height / px.width).toBeCloseTo(areaAspect(AREA));
  });

  it("is centred on the stored centre", () => {
    const px = frameToPixels({ x: 0.5, y: 0.25, scale: 0.4, rotation: 0 }, AREA, 3000, 4000);
    expect(px.cx).toBeCloseTo(1500);
    expect(px.cy).toBeCloseTo(0.25 * 4000);
  });

  it("keeps its rotation", () => {
    const px = frameToPixels({ ...FRAME, rotation: 20 }, AREA, 3000, 4000);
    expect(px.rotation).toBe(20);
  });

  it("scales with the photo", () => {
    const small = frameToPixels(FRAME, AREA, 1500, 2000);
    const large = frameToPixels(FRAME, AREA, 6000, 8000);
    expect(large.width).toBeCloseTo(small.width * 4);
    expect(large.height).toBeCloseTo(small.height * 4);
  });

  it("offers a starting frame that fits on the photo", () => {
    const frame = defaultFrame(AREA, 3000, 4000);
    const px = frameToPixels(frame, AREA, 3000, 4000);
    expect(px.cx - px.width / 2).toBeGreaterThanOrEqual(0);
    expect(px.cy - px.height / 2).toBeGreaterThanOrEqual(0);
    expect(px.cx + px.width / 2).toBeLessThanOrEqual(3000);
    expect(px.cy + px.height / 2).toBeLessThanOrEqual(4000);
    expect(px.height / px.width).toBeCloseTo(areaAspect(AREA));
  });
});

describe("the design inside the frame", () => {
  it("sits where the Studio put it, inside the frame", () => {
    const t = mapStudioPlacement(placement({ x: 0.25, y: 0.75 }), AREA, FRAME, 3000, 4000);
    const px = frameToPixels(FRAME, AREA, 3000, 4000);
    expect(t.x * 3000).toBeCloseTo(px.cx + (0.25 - 0.5) * px.width);
    expect(t.y * 4000).toBeCloseTo(px.cy + (0.75 - 0.5) * px.height);
  });

  it("scales as a fraction of the AREA, not of the photo", () => {
    const t = mapStudioPlacement(placement({ scale: 0.5 }), AREA, FRAME, 3000, 4000);
    const px = frameToPixels(FRAME, AREA, 3000, 4000);
    // Half the area's width, which is 600 photo pixels - a fifth of the photo.
    expect(t.scale * 3000).toBeCloseTo(0.5 * px.width);
  });

  it("is carried by the frame's rotation", () => {
    const t = mapStudioPlacement(placement({ angle: 10 }), AREA, { ...FRAME, rotation: 25 }, 3000, 4000);
    expect(t.rotation).toBe(35);
  });

  it("is carried by the frame's rotation - the centre turns with it", () => {
    const straight = mapStudioPlacement(placement({ x: 1, y: 0.5 }), AREA, FRAME, 3000, 4000);
    const turned = mapStudioPlacement(
      placement({ x: 1, y: 0.5 }),
      AREA,
      { ...FRAME, rotation: 90 },
      3000,
      4000,
    );
    const px = frameToPixels(FRAME, AREA, 3000, 4000);
    // Unturned, the design sits half a frame to the RIGHT of the centre.
    expect(straight.x * 3000).toBeCloseTo(px.cx + px.width * 0.5);
    // A quarter turn moves that offset onto the other axis.
    expect(turned.x * 3000).toBeCloseTo(px.cx);
    expect(turned.y * 4000).toBeCloseTo(straight.y * 4000 + px.width * 0.5);
  });

  it("round-trips back to the same Studio placement", () => {
    const original = placement({ x: 0.32, y: 0.61, scale: 0.42, angle: -15 });
    const t = mapStudioPlacement(original, AREA, FRAME, 3000, 4000);
    const back = studioPlacementFromTransform(t, AREA, FRAME, 3000, 4000, "front");
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
    expect(back.scale).toBeCloseTo(original.scale, 6);
    expect(back.angle).toBeCloseTo(original.angle, 6);
    expect(back.position).toBe("front");
  });

  it("round-trips through a rotated frame too", () => {
    const original = placement({ x: 0.4, y: 0.55, scale: 0.7, angle: 12 });
    const frame = { ...FRAME, rotation: 33, scale: 0.33 };
    const t = mapStudioPlacement(original, AREA, frame, 3000, 4000);
    const back = studioPlacementFromTransform(t, AREA, frame, 3000, 4000, "front");
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
    expect(back.scale).toBeCloseTo(original.scale, 6);
    expect(back.angle).toBeCloseTo(original.angle, 6);
  });
});

describe("the clip", () => {
  it("is the frame's rectangle", () => {
    const clip = clipFor(AREA, FRAME, 3000, 4000);
    const px = frameToPixels(FRAME, AREA, 3000, 4000);
    expect(clip.x).toBeCloseTo(px.cx);
    expect(clip.y).toBeCloseTo(px.cy);
    expect(clip.width).toBeCloseTo(px.width);
    expect(clip.height).toBeCloseTo(px.height);
    expect(clip.rotation).toBe(0);
  });

  it("turns with the frame", () => {
    const clip = clipFor(AREA, { ...FRAME, rotation: 15 }, 3000, 4000);
    expect(clip.rotation).toBe(15);
  });
});

describe("print areas out of the catalogue", () => {
  const variant = (id: number, placeholders: CatalogVariant["placeholders"]): CatalogVariant => ({
    id,
    title: `v${id}`,
    placeholders,
  });

  it("takes the smallest placeholder for each position", () => {
    const areas = derivePrintAreas([
      variant(1, [{ position: "front", width: 4500, height: 5400 }]),
      variant(2, [{ position: "front", width: 3600, height: 4200 }]),
      variant(3, [{ position: "back", width: 4500, height: 5400 }]),
    ]);
    const front = areas.find((a) => a.position === "front");
    expect(front?.width).toBe(3600);
    expect(front?.height).toBe(4200);
    expect(areas).toHaveLength(2);
  });

  it("ignores placeholders with no size", () => {
    expect(derivePrintAreas([variant(1, [{ position: "front" }])])).toHaveLength(0);
  });

  it("is sorted by position", () => {
    const areas = derivePrintAreas([
      variant(1, [{ position: "front", width: 100, height: 100 }]),
      variant(2, [{ position: "back", width: 100, height: 100 }]),
    ]);
    expect(areas.map((a) => a.position)).toEqual(["back", "front"]);
  });
});

describe("physical sizes", () => {
  it("turns a reference measurement into a scale", () => {
    expect(pixelsPerInch(2520, 20)).toBeCloseTo(126);
    expect(pixelsPerInch(0, 20)).toBe(0);
    expect(pixelsPerInch(100, 0)).toBe(0);
  });

  it("reports the area's size on the garment", () => {
    const a = area({ reference: { label: "chest", inches: 20, pixelsPerInch: 126 } });
    const inches = areaInches(a, 3000, 4000);
    // The frame is 1200 photo pixels wide, at 126 px per inch.
    expect(inches?.width).toBeCloseTo(1200 / 126);
    expect(inches?.height).toBeCloseTo(1440 / 126);
  });

  it("reports nothing without a reference", () => {
    expect(areaInches(area(), 3000, 4000)).toBeNull();
  });

  it("reports the design's printed size as a fraction of the area", () => {
    const a = area({ reference: { label: "chest", inches: 20, pixelsPerInch: 126 } });
    const inches = designInches(0.5, 1, a, 3000, 4000);
    // Half the area's width.
    expect(inches?.width).toBeCloseTo((1200 / 126) * 0.5);
    // The artwork is as tall as it is wide, and the area is 1.2 times as tall
    // as it is wide, so the artwork covers 0.5/1.2 of the area's height.
    expect(inches?.height).toBeCloseTo((1440 / 126) * (0.5 / 1.2));
  });
});

describe("print-area templates", () => {
  it("carries the area and the frame across", () => {
    const original = area({
      label: "Front (DTG)",
      source: { kind: "studio", blueprintId: 71, printProviderId: 30, position: "front" },
      reference: { label: "chest", inches: 20, pixelsPerInch: 126 },
      clipMode: "behind-garment",
      frame: { x: 0.4, y: 0.3, scale: 0.35, rotation: 12 },
    });
    const payload = printAreaTemplateFrom(original);
    expect(payload.type).toBe("print-area");
    const restored = printAreaFromTemplate(payload);
    expect(restored.areaWidth).toBe(original.areaWidth);
    expect(restored.areaHeight).toBe(original.areaHeight);
    expect(restored.label).toBe(original.label);
    expect(restored.source).toEqual(original.source);
    expect(restored.frame).toEqual(original.frame);
    expect(restored.reference).toEqual(original.reference);
    expect(restored.clipMode).toBe("behind-garment");
  });
});

describe("reading a stored area", () => {
  it("upgrades the old box to a frame", () => {
    const restored = normalisePrintArea({
      areaWidth: 4500,
      areaHeight: 5400,
      label: "Front",
      source: { kind: "printify", blueprintId: 71, printProviderId: 30, position: "front" },
      box: { x: 0.5, y: 0.26, width: 0.4 },
      clipMode: "area",
      updatedAt: 1,
    });
    expect(restored?.frame).toEqual({ x: 0.5, y: 0.26, scale: 0.4, rotation: 0 });
    expect(restored?.source).toEqual({
      kind: "studio",
      blueprintId: 71,
      printProviderId: 30,
      position: "front",
    });
  });

  it("keeps a stored frame as it is", () => {
    const stored = area({ frame: { x: 0.3, y: 0.2, scale: 0.2, rotation: 45 } });
    const restored = normalisePrintArea(stored);
    expect(restored?.frame).toEqual(stored.frame);
    expect(restored?.source).toEqual(stored.source);
  });

  it("refuses rubbish", () => {
    expect(normalisePrintArea(undefined)).toBeUndefined();
    expect(normalisePrintArea({})).toBeUndefined();
    expect(normalisePrintArea({ areaWidth: 4500 })).toBeUndefined();
  });
});

describe("the manual fallback presets", () => {
  it("are all usable sizes", () => {
    expect(PRINT_AREA_PRESETS.length).toBeGreaterThan(0);
    for (const preset of PRINT_AREA_PRESETS) {
      expect(preset.width).toBeGreaterThan(0);
      expect(preset.height).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });

  it("can be found by id", () => {
    expect(findPrintAreaPreset("tee-dtg-front")?.width).toBe(4500);
    expect(findPrintAreaPreset("nope")).toBeUndefined();
  });

  it("offers the sizes that make sense for a mockup's category", () => {
    const tees = presetsForCategory("tshirt");
    expect(tees.length).toBeGreaterThan(0);
    expect(tees.every((p) => p.categories.includes("tshirt"))).toBe(true);
    // A mug does not get the tee's sizes.
    expect(presetsForCategory("mug").some((p) => p.id === "tee-dtg-front")).toBe(false);
  });
});
