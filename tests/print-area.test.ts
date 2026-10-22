import { describe, expect, it } from "vitest";
import {
  areaAspect,
  areaInches,
  boxToPixels,
  defaultBox,
  derivePrintAreas,
  designInches,
  mapStudioPlacement,
  pixelsPerInch,
  printAreaFromTemplate,
  printAreaTemplateFrom,
  studioPlacementFromTransform,
} from "@/lib/mockups/print-area";
import { PRINT_AREA_PRESETS, findPrintAreaPreset } from "@/lib/printify/presets";
import type { MockupPrintArea, StudioPlacement } from "@/types/domain";
import type { CatalogVariant } from "@/lib/printify/types";

/** A 4500 x 5400 DTG area - the one that matters most. */
const AREA = { areaWidth: 4500, areaHeight: 5400 };
const BOX = { x: 0.5, y: 0.4, width: 0.5 };

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
  box: BOX,
  clipMode: "area",
  updatedAt: 0,
  ...patch,
});

describe("the print area box", () => {
  it("keeps the Printify area's aspect, whatever the box width", () => {
    const px = boxToPixels(BOX, AREA, 3000, 4000);
    expect(px.width).toBeCloseTo(1500);
    // 5400/4500 = 1.2 - the box is 1.2 times as tall as it is wide.
    expect(px.height).toBeCloseTo(1800);
    expect(px.height / px.width).toBeCloseTo(areaAspect(AREA));
  });

  it("is centred on the stored centre", () => {
    const px = boxToPixels({ x: 0.5, y: 0.25, width: 0.4 }, AREA, 3000, 4000);
    expect(px.x + px.width / 2).toBeCloseTo(1500);
    expect(px.y + px.height / 2).toBeCloseTo(0.25 * 4000);
  });

  it("scales with the photo", () => {
    const small = boxToPixels(BOX, AREA, 1500, 2000);
    const large = boxToPixels(BOX, AREA, 6000, 8000);
    expect(large.width).toBeCloseTo(small.width * 4);
    expect(large.height).toBeCloseTo(small.height * 4);
  });

  it("offers a starting box that fits on the photo", () => {
    const box = defaultBox(AREA, 3000, 4000);
    const px = boxToPixels(box, AREA, 3000, 4000);
    expect(px.x).toBeGreaterThanOrEqual(0);
    expect(px.y).toBeGreaterThanOrEqual(0);
    expect(px.x + px.width).toBeLessThanOrEqual(3000);
    expect(px.y + px.height).toBeLessThanOrEqual(4000);
    expect(px.height / px.width).toBeCloseTo(areaAspect(AREA));
  });
});

describe("mapping the Studio placement onto the mockup", () => {
  it("puts the design's centre where the Studio put it", () => {
    const t = mapStudioPlacement(placement({ x: 0.25, y: 0.75 }), AREA, BOX, 3000, 4000);
    const px = boxToPixels(BOX, AREA, 3000, 4000);
    expect(t.x * 3000).toBeCloseTo(px.x + 0.25 * px.width);
    expect(t.y * 4000).toBeCloseTo(px.y + 0.75 * px.height);
  });

  it("scales the design as a fraction of the AREA, not of the photo", () => {
    const t = mapStudioPlacement(placement({ scale: 0.5 }), AREA, BOX, 3000, 4000);
    const px = boxToPixels(BOX, AREA, 3000, 4000);
    // Half the area's width, which is 1500 photo pixels - half the photo.
    expect(t.scale * 3000).toBeCloseTo(0.5 * px.width);
  });

  it("carries the rotation through", () => {
    const t = mapStudioPlacement(placement({ angle: 30 }), AREA, BOX, 3000, 4000);
    expect(t.rotation).toBe(30);
  });

  it("round-trips back to the same Studio placement", () => {
    const original = placement({ x: 0.32, y: 0.61, scale: 0.42, angle: -15 });
    const t = mapStudioPlacement(original, AREA, BOX, 3000, 4000);
    const back = studioPlacementFromTransform(t, AREA, BOX, 3000, 4000, "front");
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
    expect(back.scale).toBeCloseTo(original.scale, 6);
    expect(back.angle).toBeCloseTo(original.angle, 6);
    expect(back.position).toBe("front");
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
    // The box is 1500 photo pixels wide, at 126 px per inch.
    expect(inches?.width).toBeCloseTo(1500 / 126);
    expect(inches?.height).toBeCloseTo(1800 / 126);
  });

  it("reports nothing without a reference", () => {
    expect(areaInches(area(), 3000, 4000)).toBeNull();
  });

  it("reports the design's printed size as a fraction of the area", () => {
    const a = area({ reference: { label: "chest", inches: 20, pixelsPerInch: 126 } });
    const inches = designInches(0.5, 1, a, 3000, 4000);
    // Half the area's width.
    expect(inches?.width).toBeCloseTo((1500 / 126) * 0.5);
    // The artwork is as tall as it is wide, and the area is 1.2 times as tall
    // as it is wide, so the artwork covers 0.5/1.2 of the area's height.
    expect(inches?.height).toBeCloseTo((1800 / 126) * (0.5 / 1.2));
  });
});

describe("print-area templates", () => {
  it("carries the area and the box across", () => {
    const original = area({
      label: "Front (DTG)",
      source: { kind: "printify", blueprintId: 71, printProviderId: 30, position: "front" },
      reference: { label: "chest", inches: 20, pixelsPerInch: 126 },
      clipMode: "behind-garment",
    });
    const payload = printAreaTemplateFrom(original);
    expect(payload.type).toBe("print-area");
    const restored = printAreaFromTemplate(payload);
    expect(restored.areaWidth).toBe(original.areaWidth);
    expect(restored.areaHeight).toBe(original.areaHeight);
    expect(restored.label).toBe(original.label);
    expect(restored.source).toEqual(original.source);
    expect(restored.box).toEqual(original.box);
    expect(restored.reference).toEqual(original.reference);
    expect(restored.clipMode).toBe("behind-garment");
  });

  it("keeps the box a fraction of the photo, so it transfers", () => {
    const payload = printAreaTemplateFrom(area());
    const restored = printAreaFromTemplate(payload);
    expect(restored.box.width).toBe(BOX.width);
    expect(restored.box.x).toBe(BOX.x);
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
});
