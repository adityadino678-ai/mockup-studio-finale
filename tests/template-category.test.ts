import { describe, expect, it } from "vitest";
import { mockupCategoryFor } from "@/lib/mockups/template-category";
import type { CatalogBlueprint } from "@/lib/printify/types";

const blueprint = (overrides: Partial<CatalogBlueprint> = {}): CatalogBlueprint => ({
  id: 1,
  title: "Unisex Jersey T-Shirt",
  brand: "Test Brand",
  category: "T-shirts",
  ...overrides,
});

describe("mockupCategoryFor", () => {
  it("maps a t-shirt blueprint to tshirt", () => {
    expect(mockupCategoryFor(blueprint({ title: "Unisex Jersey T-Shirt", category: "T-shirts" }))).toBe("tshirt");
    expect(mockupCategoryFor(blueprint({ title: "Classic Tee", category: "Apparel" }))).toBe("tshirt");
  });

  it("maps a hoodie blueprint to hoodie", () => {
    expect(mockupCategoryFor(blueprint({ title: "Pullover Hoodie", category: "Apparel" }))).toBe("hoodie");
    expect(mockupCategoryFor(blueprint({ title: "Sweatshirt Hood", category: "Apparel" }))).toBe("hoodie");
  });

  it("maps a mug blueprint to mug", () => {
    expect(mockupCategoryFor(blueprint({ title: "Ceramic Mug", category: "Mugs & Bottles" }))).toBe("mug");
    expect(mockupCategoryFor(blueprint({ title: "Travel Tumbler", category: "Drinkware" }))).toBe("mug");
  });

  it("maps a poster blueprint to poster", () => {
    expect(mockupCategoryFor(blueprint({ title: "Art Poster", category: "Home Decor" }))).toBe("poster");
    expect(mockupCategoryFor(blueprint({ title: "Wall Art Print", category: "Home Decor" }))).toBe("poster");
  });

  it("maps a tote blueprint to tote", () => {
    expect(mockupCategoryFor(blueprint({ title: "Canvas Tote Bag", category: "Accessories" }))).toBe("tote");
  });

  it("maps a sticker blueprint to sticker", () => {
    expect(mockupCategoryFor(blueprint({ title: "Die-Cut Sticker", category: "Stickers & Labels" }))).toBe("sticker");
    expect(mockupCategoryFor(blueprint({ title: "Vinyl Decal", category: "Stickers & Labels" }))).toBe("sticker");
  });

  it("falls back to other for unknown categories", () => {
    expect(mockupCategoryFor(blueprint({ title: "Phone Case", category: "Phone & Tech" }))).toBe("other");
    expect(mockupCategoryFor(blueprint({ title: "Something Weird", category: "Pets" }))).toBe("other");
  });

  it("checks hoodie before t-shirt so hoodies are not misclassified", () => {
    expect(mockupCategoryFor(blueprint({ title: "Hoodie Tee Shirt", category: "Apparel" }))).toBe("hoodie");
  });
});
