import { describe, expect, it } from "vitest";
import {
  buildStudioListings,
  catalogProductName,
  groupStudioListings,
} from "@/lib/printify/listing-plan";
import {
  emptySession,
  listingMockupIds,
  listingRenderFor,
  parseTags,
  priceForListing,
  remapListingState,
  renderTemplate,
  renderTitle,
} from "@/lib/printify/studio-session";
import { nextListingImageState } from "@/lib/printify/listing-drafts";
import {
  listingImageFingerprint,
  listingRenderFingerprint,
} from "@/lib/printify/listing-render";
import {
  bridgePayloadJson,
  buildBridgePayload,
  countBridgeImages,
} from "@/lib/printify/mockup-bridge";
import { MOCKUP_BRIDGE_BOOKMARKLET } from "@/lib/printify/bookmarklet";
import { DEFAULT_TRANSFORM } from "@/types/domain";
import type { StudioListingRender } from "@/types/domain";

function design(id: string, name = id) {
  return {
    id,
    name,
    originalAssetId: `asset-${id}`,
    processedAssetId: undefined,
  };
}

function withScope(ids: string[]) {
  return { ...emptySession(), designIds: ids };
}

describe("the listing plan", () => {
  it("creates no listing when nothing is ticked", () => {
    const session = emptySession();
    expect(buildStudioListings([design("a"), design("b")], session)).toEqual([]);
  });

  it("makes one listing per ordinary design and uses the row tick", () => {
    const session = { ...withScope(["a", "b"]), inkPairIds: ["b"] };
    const listings = buildStudioListings(
      [
        design("a", "Alpha"),
        { ...design("b", "Beta"), whiteInkAssetId: "ink-b" },
      ],
      session,
    );
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      listingId: "a",
      designName: "Alpha",
      row: "plain",
      memberIds: ["a"],
      artworkAssetId: "asset-a",
    });
    expect(listings[1]).toMatchObject({ listingId: "b", row: "ink", memberIds: ["b"] });
  });

  it("makes one listing for a pair, owned by the black-ink half", () => {
    const session = {
      ...withScope(["black", "white"]),
      inkPairIds: ["black", "white"],
      inkPairs: [{ blackInkDesignId: "black", whiteInkDesignId: "white" }],
    };
    const listings = buildStudioListings(
      [design("white", "White half"), design("black", "Black half")],
      session,
    );
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      listingId: "black",
      designName: "Black half",
      row: "ink",
      memberIds: ["black", "white"],
      partnerDesignId: "white",
      partnerName: "White half",
      artworkAssetId: "asset-black",
    });
  });

  it("treats a half-pair as ordinary designs instead of guessing", () => {
    const session = {
      ...withScope(["black"]),
      inkPairIds: ["black", "white"],
      inkPairs: [{ blackInkDesignId: "black", whiteInkDesignId: "white" }],
    };
    const listings = buildStudioListings([design("black"), design("white")], session);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ listingId: "black", memberIds: ["black"] });
    expect(listings[0].partnerDesignId).toBeUndefined();
  });

  it("keeps the gallery's order and splits the two rows", () => {
    const session = {
      ...withScope(["a", "b", "c"]),
      inkPairIds: ["b", "c"],
      inkPairs: [{ blackInkDesignId: "b", whiteInkDesignId: "c" }],
    };
    const listings = buildStudioListings([design("a"), design("b"), design("c")], session);
    expect(listings.map((listing) => listing.listingId)).toEqual(["a", "b"]);
    const grouped = groupStudioListings(listings);
    expect(grouped.plain.map((listing) => listing.listingId)).toEqual(["a"]);
    expect(grouped.ink.map((listing) => listing.listingId)).toEqual(["b"]);
  });

  it("uses the processed artwork when the design has a cutout", () => {
    const session = withScope(["a"]);
    const listings = buildStudioListings(
      [{ ...design("a"), processedAssetId: "cutout-a" }],
      session,
    );
    expect(listings[0].artworkAssetId).toBe("cutout-a");
  });

  it("names the catalogue product and falls back safely", () => {
    expect(catalogProductName([{ id: 6, title: "Unisex Tee" }], 6)).toBe("Unisex Tee");
    expect(catalogProductName([{ id: 6, title: "Unisex Tee" }], 99)).toBe("Printify product");
    expect(catalogProductName([], 6)).toBe("Printify product");
  });
});

describe("listing copy and prices", () => {
  it("parses tags from commas and newlines, dedupes, and strips #", () => {
    expect(parseTags("Retro, #Gift, retro\nTee,  , gift")).toEqual(["Retro", "Gift", "Tee"]);
  });

  it("caps tag length and count", () => {
    const tags = parseTags(
      Array.from({ length: 20 }, (_, i) => `${i}-${"x".repeat(40)}`).join(","),
    );
    expect(tags).toHaveLength(13);
    expect(tags.every((tag) => tag.length <= 20)).toBe(true);
  });

  it("expands the title placeholders and keeps the canonical fallback", () => {
    expect(renderTitle("{design} — {product}", "Sunset", "Unisex Tee")).toBe(
      "Sunset — Unisex Tee",
    );
    expect(renderTitle("", "Sunset", "Unisex Tee")).toBe("Sunset — Unisex Tee");
    expect(renderTemplate("Hi {design} on {product}", "Sunset", "Tee", "", 6)).toBe("Hi Sun");
  });

  it("uses the fixed price, or the listing's custom price when set", () => {
    const fixed = { ...emptySession(), priceCents: 2499 };
    expect(priceForListing(fixed, "a")).toBe(2499);

    const custom = {
      ...emptySession(),
      priceCents: 2499,
      priceMode: "custom" as const,
      listingPrices: { a: 1999 },
    };
    expect(priceForListing(custom, "a")).toBe(1999);
    expect(priceForListing(custom, "b")).toBe(2499);
  });

  it("reads the selected images and cached renders in click order", () => {
    const render: StudioListingRender = {
      assetId: "render-1",
      fingerprint: "fp",
      designId: "a",
      mockupId: "m1",
      renderedAt: 1,
    };
    const session = {
      ...emptySession(),
      listingImages: { a: ["m2", "m1"] },
      listingRenders: { "a:m1": render },
    };
    expect(listingMockupIds(session, "a")).toEqual(["m2", "m1"]);
    expect(listingRenderFor(session, "a", "m1")).toEqual(render);
    expect(listingRenderFor(session, "a", "m2")).toBeUndefined();
  });
});

describe("the listing render fingerprint", () => {
  const mockup = {
    assetId: "mockup-asset",
    width: 1200,
    height: 1600,
    printArea: undefined,
  };
  const placement = { position: "front", x: 0.5, y: 0.5, scale: 1, angle: 0 };

  it("is stable for identical inputs", () => {
    expect(
      listingRenderFingerprint({ designAssetId: "art", mockup, placement }),
    ).toBe(listingRenderFingerprint({ designAssetId: "art", mockup, placement }));
  });

  it("changes when the artwork, mockup or placement changes", () => {
    const base = listingRenderFingerprint({ designAssetId: "art", mockup, placement });
    expect(listingRenderFingerprint({ designAssetId: "art-2", mockup, placement })).not.toBe(base);
    expect(
      listingRenderFingerprint({
        designAssetId: "art",
        mockup: { ...mockup, assetId: "other" },
        placement,
      }),
    ).not.toBe(base);
    expect(
      listingRenderFingerprint({
        designAssetId: "art",
        mockup,
        placement: { ...placement, scale: 1.2 },
      }),
    ).not.toBe(base);
  });

  it("includes the saved placement used for a mockup without a print area", () => {
    const base = listingRenderFingerprint({ designAssetId: "art", mockup, placement });
    const moved = listingRenderFingerprint({
      designAssetId: "art",
      mockup,
      placement,
      fallbackTransform: { ...DEFAULT_TRANSFORM, x: 0.4 },
    });
    expect(moved).not.toBe(base);
    const behind = listingRenderFingerprint({
      designAssetId: "art",
      mockup,
      placement,
      behindMockup: true,
    });
    expect(behind).not.toBe(base);
  });

  it("uses version 2 and ignores print-area fields that do not change pixels", () => {
    const printArea = {
      areaWidth: 4500,
      areaHeight: 5400,
      source: { kind: "studio" as const, blueprintId: 6, printProviderId: 30, position: "front" },
      label: "Front (DTG)",
      frame: { x: 0.5, y: 0.5, scale: 0.4, rotation: 0 },
      clipMode: "area" as const,
      updatedAt: 1,
    };
    const mockupWithArea = { ...mockup, printArea };
    const base = listingRenderFingerprint({
      designAssetId: "art",
      mockup: mockupWithArea,
      placement,
    });
    expect(JSON.parse(base).version).toBe(2);

    const cosmetic = listingRenderFingerprint({
      designAssetId: "art",
      mockup: {
        ...mockupWithArea,
        printArea: {
          ...printArea,
          label: "Something else",
          updatedAt: 999,
          reference: { label: "chest", inches: 12, pixelsPerInch: 100 },
        },
      },
      placement,
    });
    expect(cosmetic).toBe(base);

    expect(
      listingRenderFingerprint({
        designAssetId: "art",
        mockup: {
          ...mockupWithArea,
          printArea: { ...printArea, frame: { ...printArea.frame, scale: 0.5 } },
        },
        placement,
      }),
    ).not.toBe(base);
    expect(
      listingRenderFingerprint({
        designAssetId: "art",
        mockup: {
          ...mockupWithArea,
          printArea: { ...printArea, clipMode: "behind-garment" as const },
        },
        placement,
      }),
    ).not.toBe(base);
    expect(
      listingRenderFingerprint({
        designAssetId: "art",
        mockup: {
          ...mockupWithArea,
          printArea: {
            ...printArea,
            crop: { x: 0, y: 0, width: 1, height: 0.6 },
          },
        },
        placement,
      }),
    ).not.toBe(base);
  });

  it("ignores the saved transform when a print area maps the placement", () => {
    const printArea = {
      areaWidth: 4500,
      areaHeight: 5400,
      source: { kind: "studio" as const, blueprintId: 6, printProviderId: 30, position: "front" },
      label: "Front",
      frame: { x: 0.5, y: 0.5, scale: 0.4, rotation: 0 },
      clipMode: "area" as const,
      updatedAt: 1,
    };
    const listing = buildStudioListings([design("a")], withScope(["a"]))[0];
    const mockupWithArea = { ...mockup, printArea };
    const base = listingImageFingerprint({ listing, mockup: mockupWithArea, placement });
    expect(
      listingImageFingerprint({
        listing,
        mockup: mockupWithArea,
        placement,
        saved: { transform: { ...DEFAULT_TRANSFORM, x: 0.2 }, behindMockup: undefined },
      }),
    ).toBe(base);
  });
});

describe("listing image state", () => {
  it("locks an explicit clear even if nothing is selected", () => {
    expect(
      nextListingImageState({
        selectedCount: 0,
        renderedIds: [],
        existing: { imageAssetIds: ["old"], imageSelectionLocked: true },
        explicitClear: true,
        lockSelection: false,
      }),
    ).toEqual({ imageAssetIds: [], imageSelectionLocked: true });
  });

  it("locks the complete selection in click order", () => {
    expect(
      nextListingImageState({
        selectedCount: 2,
        renderedIds: ["render-b", "render-a"],
        existing: { imageAssetIds: ["old"], imageSelectionLocked: true },
        explicitClear: false,
        lockSelection: true,
      }),
    ).toEqual({ imageAssetIds: ["render-b", "render-a"], imageSelectionLocked: true });
  });

  it("keeps an existing lock when a non-explicit save sees a complete selection", () => {
    expect(
      nextListingImageState({
        selectedCount: 1,
        renderedIds: ["render-a"],
        existing: { imageAssetIds: ["old"], imageSelectionLocked: true },
        explicitClear: false,
        lockSelection: false,
      }),
    ).toEqual({ imageAssetIds: ["render-a"], imageSelectionLocked: true });
  });

  it("never drops selected images when only some have fresh renders", () => {
    expect(
      nextListingImageState({
        selectedCount: 3,
        renderedIds: ["render-a"],
        existing: { imageAssetIds: ["old-a", "old-b", "old-c"], imageSelectionLocked: true },
        explicitClear: false,
        lockSelection: true,
      }),
    ).toEqual({
      imageAssetIds: ["old-a", "old-b", "old-c"],
      imageSelectionLocked: true,
    });
  });

  it("treats an untouched empty selection as never configured", () => {
    expect(
      nextListingImageState({
        selectedCount: 0,
        renderedIds: [],
        existing: undefined,
        explicitClear: false,
        lockSelection: true,
      }),
    ).toEqual({ imageAssetIds: [], imageSelectionLocked: undefined });
  });
});

describe("pair-owner remapping", () => {
  const render = (designId: string, mockupId: string): StudioListingRender => ({
    assetId: `render-${designId}-${mockupId}`,
    fingerprint: `${designId}:${mockupId}`,
    designId,
    mockupId,
    renderedAt: 1,
  });

  it("moves listing state to the new black owner and drops the old white state", () => {
    const session = {
      ...emptySession(),
      listingImages: { old: ["m1"], other: ["x"] },
      listingImageCleared: { old: true as const, other: true as const },
      listingPrices: { old: 1999, other: 2999 },
      listingRenders: {
        "old:m1": render("old", "m1"),
        "new:m2": render("new", "m2"),
        "other:m3": render("other", "m3"),
      },
    };
    const patch = remapListingState(session, "old", "new");
    expect(patch.listingImages).toEqual({ other: ["x"], new: ["m1"] });
    expect(patch.listingImageCleared).toEqual({ other: true, new: true });
    expect(patch.listingPrices).toEqual({ other: 2999, new: 1999 });
    expect(patch.listingRenders).toEqual({
      "new:m1": { ...render("old", "m1"), designId: "new" },
      "other:m3": render("other", "m3"),
    });
  });
});

describe("the Printify bridge payload", () => {
  it("counts every image and serializes ids only", () => {
    const payload = buildBridgePayload([
      {
        shopId: 1,
        productId: "p1",
        productTitle: "One",
        uploads: [
          {
            libraryId: "lib1",
            mockupId: "m1",
            src: "https://images.printify.com/m1.jpg",
            filename: "one.jpg",
          },
        ],
      },
      {
        shopId: 1,
        productId: "p2",
        productTitle: "Two",
        uploads: [
          {
            libraryId: "lib2",
            mockupId: "m2",
            src: "https://images.printify.com/m2.jpg",
            filename: "two.jpg",
          },
          {
            libraryId: "lib3",
            mockupId: "m3",
            src: "https://images.printify.com/m3.jpg",
            filename: "three.jpg",
          },
        ],
      },
    ]);

    expect(payload.source).toBe("mockup-studio");
    expect(payload.version).toBe(1);
    expect(countBridgeImages(payload)).toBe(3);
    const raw = bridgePayloadJson(payload);
    expect(raw).toContain('"productId": "p1"');
    expect(raw).not.toMatch(/token|password|access_token/i);
  });

  it("is valid bookmarklet JavaScript after the browser strips newlines", () => {
    expect(MOCKUP_BRIDGE_BOOKMARKLET.startsWith("javascript:")).toBe(true);
    const source = MOCKUP_BRIDGE_BOOKMARKLET.slice("javascript:".length);
    // A javascript: URL drops ASCII tab/newline characters before execution.
    // A line comment therefore swallows the rest of the bookmarklet, so parse
    // exactly what the browser will run, not the pretty-printed source.
    const browserSource = source.replace(/[\r\n\t]/g, "");
    expect(() => new Function(browserSource)).not.toThrow();
    expect(source).toContain("/mockup-library-layout");
    expect(source).toContain("/selected-mockups");
    expect(source).toContain("not_linked");
  });
});
