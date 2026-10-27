import { describe, expect, it } from "vitest";
import {
  autoApplyTemplate,
  PRESET_TEMPLATES,
  templateForCategory,
} from "@/lib/mockups/templates";
import type { MockupCategory } from "@/types/domain";
import type { CatalogBlueprint } from "@/lib/printify/types";

const blueprint = (overrides: Partial<CatalogBlueprint> = {}): CatalogBlueprint => ({
  id: 1,
  title: "Unisex Jersey T-Shirt",
  brand: "Test Brand",
  category: "T-shirts",
  ...overrides,
});

const mockup = {
  id: "mockup-1",
  name: "Tee photo",
  category: "tshirt" as MockupCategory,
  tags: [],
  favorite: false,
  assetId: "asset-1",
  width: 3000,
  height: 4000,
  source: "user" as const,
  createdAt: 1767225600000,
};

describe("PRESET_TEMPLATES", () => {
  it("has one template per product type preset", () => {
    // At minimum we expect tshirt, hoodie, mug, poster, tote, sticker.
    const found = new Set<string>();
    for (const t of PRESET_TEMPLATES) {
      found.add(t.label);
    }
    expect(found.size).toBeGreaterThanOrEqual(6);
  });

  it("every template has a valid payload shape", () => {
    for (const t of PRESET_TEMPLATES) {
      expect(t.type).toBe("print-area");
      expect(t.areaWidth).toBeGreaterThan(0);
      expect(t.areaHeight).toBeGreaterThan(0);
      expect(t.source.kind).toBe("preset");
      expect(t.label.length).toBeGreaterThan(0);
      expect(typeof t.frame.x).toBe("number");
      expect(typeof t.frame.y).toBe("number");
      expect(typeof t.frame.scale).toBe("number");
      expect(t.clipMode).toBe("area");
    }
  });
});

describe("templateForCategory", () => {
  it("returns the tee template for tshirt", () => {
    const t = templateForCategory("tshirt");
    expect(t).toBeDefined();
    expect(t!.label).toContain("Tee");
  });

  it("returns the hoodie template for hoodie", () => {
    const t = templateForCategory("hoodie");
    expect(t).toBeDefined();
    expect(t!.label).toContain("Hoodie");
  });

  it("returns the mug template for mug", () => {
    const t = templateForCategory("mug");
    expect(t).toBeDefined();
    expect(t!.label).toContain("Mug");
  });

  it("returns the poster template for poster", () => {
    const t = templateForCategory("poster");
    expect(t).toBeDefined();
    expect(t!.label).toContain("Poster");
  });

  it("returns the tote template for tote", () => {
    const t = templateForCategory("tote");
    expect(t).toBeDefined();
    expect(t!.label).toContain("Tote");
  });

  it("returns the sticker template for sticker", () => {
    const t = templateForCategory("sticker");
    expect(t).toBeDefined();
    expect(t!.label).toContain("Sticker");
  });

  it("returns undefined for other", () => {
    expect(templateForCategory("other")).toBeUndefined();
  });
});

describe("autoApplyTemplate", () => {
  it("applies the tee template to a t-shirt blueprint", () => {
    const area = autoApplyTemplate(blueprint({ title: "Unisex Jersey T-Shirt" }), mockup);
    expect(area).toBeDefined();
    expect(area!.label).toContain("Tee");
    expect(area!.source).toEqual({ kind: "preset", presetId: "tee-dtg-front" });
    expect(area!.areaWidth).toBe(4500);
    expect(area!.areaHeight).toBe(5400);
  });

  it("applies the hoodie template to a hoodie blueprint", () => {
    const area = autoApplyTemplate(blueprint({ title: "Pullover Hoodie" }), mockup);
    expect(area).toBeDefined();
    expect(area!.label).toContain("Hoodie");
    expect(area!.areaWidth).toBe(4500);
    expect(area!.areaHeight).toBe(6000);
  });

  it("applies the mug template to a mug blueprint", () => {
    const area = autoApplyTemplate(blueprint({ title: "Ceramic Mug" }), mockup);
    expect(area).toBeDefined();
    expect(area!.label).toContain("Mug");
    expect(area!.areaWidth).toBe(2475);
    expect(area!.areaHeight).toBe(2475);
  });

  it("applies the poster template to a poster blueprint", () => {
    const area = autoApplyTemplate(blueprint({ title: "Art Poster" }), mockup);
    expect(area).toBeDefined();
    expect(area!.label).toContain("Poster");
    expect(area!.areaWidth).toBe(4500);
    expect(area!.areaHeight).toBe(6000);
  });

  it("applies the tote template to a tote blueprint", () => {
    const area = autoApplyTemplate(blueprint({ title: "Canvas Tote Bag" }), mockup);
    expect(area).toBeDefined();
    expect(area!.label).toContain("Tote");
    expect(area!.areaWidth).toBe(4500);
    expect(area!.areaHeight).toBe(4500);
  });

  it("applies the sticker template to a sticker blueprint", () => {
    const area = autoApplyTemplate(blueprint({ title: "Die-Cut Sticker" }), mockup);
    expect(area).toBeDefined();
    expect(area!.label).toContain("Sticker");
    expect(area!.areaWidth).toBe(2000);
    expect(area!.areaHeight).toBe(2000);
  });

  it("returns undefined for an unknown blueprint", () => {
    const area = autoApplyTemplate(blueprint({ title: "Phone Case", category: "Phone & Tech" }), mockup);
    expect(area).toBeUndefined();
  });

  it("produces a frame with sensible defaults", () => {
    const area = autoApplyTemplate(blueprint({ title: "Unisex Jersey T-Shirt" }), mockup);
    expect(area).toBeDefined();
    expect(area!.frame.x).toBe(0.5);
    expect(area!.frame.scale).toBeGreaterThan(0);
    expect(area!.frame.scale).toBeLessThanOrEqual(1);
    expect(area!.clipMode).toBe("area");
  });

  it("is pure - does not mutate inputs", () => {
    const before = { ...blueprint() };
    autoApplyTemplate(before, mockup);
    expect(before.title).toBe("Unisex Jersey T-Shirt");
    expect(before.category).toBe("T-shirts");
  });
});
