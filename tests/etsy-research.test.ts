import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ETSY_RESEARCH_DISCLAIMER,
  EtsyApiError,
  normaliseEtsyResearch,
  searchEtsyActiveListings,
  titleTerms,
} from "@/lib/server/etsy";

// ---------------------------------------------------------------------------
// Etsy research is READ-ONLY and honest.
//
// Etsy's public API exposes active listings, not search volume, sales or
// rankings. These tests pin the defensive normalisation (a malformed listing
// must not fail the whole search), the observed-data shape, and the error
// messages a seller can act on.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("titleTerms", () => {
  it("lower-cases, strips punctuation and removes stop words", () => {
    expect(titleTerms("Personalized Gift for Her — Custom T-Shirt!")).toEqual([
      "personalized",
      "custom",
      "shirt",
    ]);
  });

  it("de-duplicates repeated words", () => {
    expect(titleTerms("Cat cat CAT shirt")).toEqual(["cat", "shirt"]);
  });
});

describe("normaliseEtsyResearch", () => {
  it("normalises tags, prices, samples and observed terms", () => {
    const research = normaliseEtsyResearch(
      "  personalized gift  ",
      {
        count: "1234",
        results: [
          {
            title: "Personalized Cat Shirt, Custom Cat Gift",
            tags: ["cat shirt", "Cat Shirt", "personalized gift", "cat mom"],
            price: { amount: 2499, divisor: 100, currency_code: "USD" },
            url: "https://www.etsy.com/listing/1/cat-shirt",
          },
          {
            title: "Custom Cat Mug",
            tags: ["cat mug", "custom mug"],
            price: { amount: 1500, divisor: 100, currency_code: "USD" },
          },
          {
            // Malformed but survivable: no title, no tags, no price.
            listing_id: 3,
          },
        ],
      },
      1_700_000_000_000,
    );

    expect(research).toMatchObject({
      query: "personalized gift",
      searchedAt: 1_700_000_000_000,
      source: "etsy-api",
      activeListings: 1234,
      sampled: 3,
      medianPriceCents: 2000,
      currency: "USD",
      disclaimer: ETSY_RESEARCH_DISCLAIMER,
    });
    expect(research.topTags).toContainEqual({ term: "cat shirt", count: 1 });
    expect(research.topTags.map((entry) => entry.term)).toContain("personalized gift");
    expect(research.titleTerms.map((entry) => entry.term)).toContain("cat");
    expect(research.samples).toHaveLength(3);
    expect(research.samples[0]).toMatchObject({
      title: "Personalized Cat Shirt, Custom Cat Gift",
      tags: ["cat shirt", "personalized gift", "cat mom"],
      priceCents: 2499,
      currency: "USD",
      url: "https://www.etsy.com/listing/1/cat-shirt",
    });
    // The malformed row still contributes a sample, but no invented price.
    expect(research.samples[2]).not.toHaveProperty("priceCents");
  });

  it("counts a term once per listing even when it repeats in the same title", () => {
    const research = normaliseEtsyResearch("cat", {
      results: [
        { title: "Cat cat cat shirt", tags: ["cat", "Cat"] },
        { title: "Cat mug", tags: ["cat"] },
      ],
    });
    expect(research.activeListings).toBe(2);
    expect(research.topTags.find((entry) => entry.term === "cat")).toEqual({
      term: "cat",
      count: 2,
    });
    expect(research.titleTerms.find((entry) => entry.term === "cat")).toEqual({
      term: "cat",
      count: 2,
    });
  });

  it("never invents a price or a non-https sample URL", () => {
    const research = normaliseEtsyResearch("x", {
      results: [
        {
          title: "X",
          price: { amount: 0, divisor: 100, currency_code: "USD" },
          url: "javascript:alert(1)",
        },
      ],
    });
    expect(research).not.toHaveProperty("medianPriceCents");
    expect(research.samples[0]).not.toHaveProperty("priceCents");
    expect(research.samples[0]).not.toHaveProperty("url");
  });
});

describe("searchEtsyActiveListings", () => {
  it("sends the keystring and returns the normalised research", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          count: 42,
          results: [
            {
              title: "Personalized Cat Shirt",
              tags: ["cat shirt"],
              price: { amount: 2499, divisor: 100, currency_code: "USD" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const research = await searchEtsyActiveListings("secret-key", "cat shirt");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("listings/active");
    expect(url).toContain("keywords=cat+shirt");
    expect(url).toContain("limit=100");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("secret-key");
    expect(research.activeListings).toBe(42);
    expect(research.topTags[0]).toEqual({ term: "cat shirt", count: 1 });
  });

  it("maps a rejected keystring to an actionable 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthenticated", { status: 401 })),
    );
    await expect(searchEtsyActiveListings("bad", "cat")).rejects.toMatchObject({
      name: "EtsyApiError",
      status: 401,
      message: expect.stringContaining("rejected the keystring"),
    } satisfies Partial<EtsyApiError>);
  });

  it("maps Etsy's rate limit to a 429 with a wait instruction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(searchEtsyActiveListings("key", "cat")).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("rate limit"),
    });
  });

  it("maps an Etsy 5xx to a 502 instead of pretending the search succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(searchEtsyActiveListings("key", "cat")).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("temporarily unavailable"),
    });
  });

  it("rejects a 200 body it cannot parse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(searchEtsyActiveListings("key", "cat")).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("could not read"),
    });
  });
});
