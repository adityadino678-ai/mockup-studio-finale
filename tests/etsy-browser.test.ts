import { describe, expect, it } from "vitest";
import {
  ETSY_BROWSER_DISCLAIMER,
  buildEtsyBrowserResearch,
  parseEtsyPriceText,
} from "@/lib/etsy/browser-research";

// ---------------------------------------------------------------------------
// The browser fallback is honest by construction.
//
// It reads titles, price labels and URLs from Etsy's public search cards. It
// cannot read tags, so it must report none. It must never invent a price from a
// malformed label, and it must not turn a non-Etsy URL into a sample link.
// ---------------------------------------------------------------------------

describe("parseEtsyPriceText", () => {
  it("reads common Etsy price labels", () => {
    expect(parseEtsyPriceText("$24.99")).toEqual({ cents: 2499, currency: "USD" });
    expect(parseEtsyPriceText("US$1,234.56")).toEqual({ cents: 123456, currency: "USD" });
    expect(parseEtsyPriceText("€24,99")).toEqual({ cents: 2499, currency: "EUR" });
    expect(parseEtsyPriceText("1.234,56 €")).toEqual({ cents: 123456, currency: "EUR" });
    expect(parseEtsyPriceText("£18.00")).toEqual({ cents: 1800, currency: "GBP" });
    expect(parseEtsyPriceText("CA$30.00")).toEqual({ cents: 3000, currency: "CAD" });
    expect(parseEtsyPriceText("AU$45.50")).toEqual({ cents: 4550, currency: "AUD" });
  });

  it("handles a single decimal digit and thousands separators", () => {
    expect(parseEtsyPriceText("24,9")).toEqual({ cents: 2490 });
    expect(parseEtsyPriceText("$1.234")).toEqual({ cents: 123400, currency: "USD" });
  });

  it("returns nothing for text that is not a positive price", () => {
    expect(parseEtsyPriceText(undefined)).toEqual({});
    expect(parseEtsyPriceText("")).toEqual({});
    expect(parseEtsyPriceText("Free shipping")).toEqual({});
    expect(parseEtsyPriceText("$0.00")).toEqual({});
    expect(parseEtsyPriceText("not a price")).toEqual({});
  });
});

describe("buildEtsyBrowserResearch", () => {
  it("reports observed cards and explicitly reports no tags", () => {
    const research = buildEtsyBrowserResearch(
      "  cat mug  ",
      [
        {
          title: "Personalized Cat Mug, Custom Cat Gift",
          priceText: "$24.99",
          url: "https://www.etsy.com/listing/1/cat-mug",
        },
        {
          title: "Cat Mom Shirt",
          priceText: "US$32.50",
          url: "https://www.etsy.com/listing/2/cat-shirt",
        },
        {
          title: "Cat Lover Tote",
          priceText: "€20,00",
          url: "https://evil.example/listing/3",
        },
        { title: "   " },
      ],
      1_700_000_000_000,
    );

    expect(research).toMatchObject({
      query: "cat mug",
      searchedAt: 1_700_000_000_000,
      source: "etsy-browser",
      activeListings: 3,
      sampled: 3,
      topTags: [],
      medianPriceCents: 2499,
      currency: "USD",
      disclaimer: ETSY_BROWSER_DISCLAIMER,
    });
    expect(research.samples).toHaveLength(3);
    expect(research.samples[0]).toMatchObject({
      title: "Personalized Cat Mug, Custom Cat Gift",
      tags: [],
      priceCents: 2499,
      currency: "USD",
      url: "https://www.etsy.com/listing/1/cat-mug",
    });
    // A non-Etsy URL is dropped rather than presented as a listing link.
    expect(research.samples[2]).not.toHaveProperty("url");
    expect(research.titleTerms.map((entry) => entry.term)).toContain("cat");
    expect(ETSY_BROWSER_DISCLAIMER).toContain("tags");
  });

  it("never invents a median price or a currency", () => {
    const research = buildEtsyBrowserResearch("cat", [{ title: "Cat mug" }]);
    expect(research).not.toHaveProperty("medianPriceCents");
    expect(research).not.toHaveProperty("currency");
  });

  it("caps the cards at 48 and the samples at 8", () => {
    const cards = Array.from({ length: 60 }, (_, index) => ({
      title: `Listing ${index}`,
      priceText: `$${index + 1}.00`,
      url: `https://www.etsy.com/listing/${index}/x`,
    }));
    const research = buildEtsyBrowserResearch("x", cards);
    expect(research.activeListings).toBe(48);
    expect(research.sampled).toBe(48);
    expect(research.samples).toHaveLength(8);
    expect(research.medianPriceCents).toBe(2450);
  });

  it("drops blank titles and non-https sample URLs", () => {
    const research = buildEtsyBrowserResearch("x", [
      { title: "   ", priceText: "$1.00" },
      { title: "Real listing", priceText: "$2.00", url: "javascript:alert(1)" },
    ]);
    expect(research.activeListings).toBe(1);
    expect(research.samples[0]).toMatchObject({ title: "Real listing", tags: [] });
    expect(research.samples[0]).not.toHaveProperty("url");
  });
});
