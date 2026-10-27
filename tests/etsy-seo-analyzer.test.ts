import { describe, expect, it } from "vitest";
import {
  analyzeSeoPatterns,
  medianPriceBand,
  priceBandForCents,
} from "@/lib/etsy/seo-analyzer";
import type { EtsyResearch } from "@/types/etsy";

const apiResearch: EtsyResearch = {
  query: "cat mug",
  searchedAt: 1_700_000_000_000,
  source: "etsy-api",
  activeListings: 42,
  sampled: 3,
  topTags: [
    { term: "cat mug", count: 3 },
    { term: "cat mom", count: 2 },
    { term: "personalized gift", count: 2 },
  ],
  titleTerms: [
    { term: "cat", count: 3 },
    { term: "mug", count: 3 },
    { term: "personalized", count: 2 },
  ],
  medianPriceCents: 2499,
  currency: "USD",
  samples: [],
  disclaimer: "observed",
};

const browserResearch: EtsyResearch = {
  ...apiResearch,
  source: "etsy-browser",
  topTags: [],
  medianPriceCents: undefined,
};

describe("priceBandForCents", () => {
  it("maps each price to its band", () => {
    expect(priceBandForCents(0)).toEqual({ label: "$0-$15", minCents: 0, maxCents: 1499 });
    expect(priceBandForCents(1499)).toEqual({ label: "$0-$15", minCents: 0, maxCents: 1499 });
    expect(priceBandForCents(1500)).toEqual({ label: "$15-$25", minCents: 1500, maxCents: 2499 });
    expect(priceBandForCents(2499)).toEqual({ label: "$15-$25", minCents: 1500, maxCents: 2499 });
    expect(priceBandForCents(2500)).toEqual({ label: "$25-$35", minCents: 2500, maxCents: 3499 });
    expect(priceBandForCents(3499)).toEqual({ label: "$25-$35", minCents: 2500, maxCents: 3499 });
    expect(priceBandForCents(3500)).toEqual({ label: "$35-$50", minCents: 3500, maxCents: 4999 });
    expect(priceBandForCents(4999)).toEqual({ label: "$35-$50", minCents: 3500, maxCents: 4999 });
    expect(priceBandForCents(5000)).toEqual({ label: "$50+", minCents: 5000 });
    expect(priceBandForCents(99999)).toEqual({ label: "$50+", minCents: 5000 });
  });
});

describe("medianPriceBand", () => {
  it("returns undefined when there is no median price", () => {
    expect(medianPriceBand({ ...apiResearch, medianPriceCents: undefined })).toBeUndefined();
  });

  it("returns the band containing the median", () => {
    const band = medianPriceBand(apiResearch);
    expect(band).toEqual({ label: "$15-$25", minCents: 1500, maxCents: 2499 });
  });
});

describe("analyzeSeoPatterns", () => {
  it("extracts title terms, tag frequencies and the median band", () => {
    const pattern = analyzeSeoPatterns(apiResearch);

    expect(pattern.source).toBe("etsy-api");
    expect(pattern.sampled).toBe(3);
    expect(pattern.currency).toBe("USD");
    expect(pattern.medianPriceCents).toBe(2499);
    expect(pattern.medianPriceBand).toEqual({ label: "$15-$25", minCents: 1500, maxCents: 2499 });
    expect(pattern.topTitleTerms).toEqual([
      { term: "cat", count: 3 },
      { term: "mug", count: 3 },
      { term: "personalized", count: 2 },
    ]);
    expect(pattern.topTagFrequencies).toEqual([
      { term: "cat mug", count: 3 },
      { term: "cat mom", count: 2 },
      { term: "personalized gift", count: 2 },
    ]);
  });

  it("reports no tags in browser mode while keeping title terms", () => {
    const pattern = analyzeSeoPatterns(browserResearch);

    expect(pattern.source).toBe("etsy-browser");
    expect(pattern.topTagFrequencies).toEqual([]);
    expect(pattern.topTitleTerms.map((entry) => entry.term)).toContain("cat");
    expect(pattern.medianPriceBand).toBeUndefined();
  });

  it("does not mutate the source research", () => {
    const before = JSON.parse(JSON.stringify(apiResearch));
    analyzeSeoPatterns(apiResearch);
    expect(apiResearch).toEqual(before);
  });
});
