import { describe, expect, it } from "vitest";
import { makeListingVariations } from "@/lib/etsy/patterns";
import type { SeoPattern } from "@/lib/etsy/seo-analyzer";

const pattern: SeoPattern = {
  source: "etsy-api",
  sampled: 10,
  topTitleTerms: [
    { term: "cat", count: 5 },
    { term: "mug", count: 5 },
    { term: "personalized", count: 3 },
    { term: "gift", count: 2 },
  ],
  topTagFrequencies: [
    { term: "cat mug", count: 4 },
    { term: "cat mom", count: 3 },
    { term: "personalized gift", count: 2 },
    { term: "coffee mug", count: 2 },
  ],
  medianPriceBand: { label: "$15-$25", minCents: 1500, maxCents: 2499 },
  medianPriceCents: 2499,
  currency: "USD",
};

function signature(variation: { title: string; tags: string[] }): string {
  return `${variation.title.toLowerCase()}::${variation.tags.join(",")}`;
}

describe("makeListingVariations", () => {
  it("returns exactly `count` variations", () => {
    const variations = makeListingVariations(pattern, 6);
    expect(variations).toHaveLength(6);
  });

  it("gives no two listings identical copy", () => {
    const variations = makeListingVariations(pattern, 20);
    const signatures = new Set(variations.map(signature));
    expect(signatures.size).toBe(variations.length);
  });

  it("is deterministic for a fixed seed", () => {
    const a = makeListingVariations(pattern, 8, { seed: 42 });
    const b = makeListingVariations(pattern, 8, { seed: 42 });
    expect(a).toEqual(b);
  });

  it("varies with a different seed", () => {
    const a = makeListingVariations(pattern, 8, { seed: 1 });
    const b = makeListingVariations(pattern, 8, { seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("caps titles and tags at the configured lengths", () => {
    const variations = makeListingVariations(pattern, 5, {
      seed: 7,
      titleMaxLength: 20,
      tagMaxLength: 6,
      maxTags: 3,
    });
    for (const variation of variations) {
      expect(variation.title.length).toBeLessThanOrEqual(20);
      expect(variation.tags.length).toBeLessThanOrEqual(3);
      for (const tag of variation.tags) {
        expect(tag.length).toBeLessThanOrEqual(6);
      }
    }
  });

  it("applies the given price to every variation", () => {
    const variations = makeListingVariations(pattern, 3, { seed: 3, priceCents: 1850 });
    for (const variation of variations) {
      expect(variation.priceCents).toBe(1850);
    }
  });

  it("falls back to the pattern's median price when none is given", () => {
    const variations = makeListingVariations(pattern, 3, { seed: 3 });
    for (const variation of variations) {
      expect(variation.priceCents).toBe(2499);
    }
  });

  it("stays distinct even with an empty term and tag pool", () => {
    const empty: SeoPattern = {
      ...pattern,
      topTitleTerms: [],
      topTagFrequencies: [],
    };
    const variations = makeListingVariations(empty, 5, { seed: 9 });
    const signatures = new Set(variations.map(signature));
    expect(signatures.size).toBe(variations.length);
    for (const variation of variations) {
      expect(variation.title).toMatch(/Listing \d+/);
    }
  });
});
