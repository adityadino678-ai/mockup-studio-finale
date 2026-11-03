import { describe, expect, it } from "vitest";
import {
  applyGlobalOrder,
  emptySession,
  listingMockupIds,
  mergeGlobalOrder,
} from "@/lib/printify/studio-session";
import {
  DEFAULT_SUBCATEGORY,
  infoCardMockups,
  infoCardsForCategory,
  infoCardsForListing,
  mockupCategoryForTitle,
  productMockups,
  subCategoriesFor,
  subCategoryOf,
} from "@/lib/mockups/info-cards";
import type { Mockup, StudioSession } from "@/types/domain";

// ---------------------------------------------------------------------------
// ONE global image order is shared by every listing. `listingImages` says
// WHICH mockups a listing uses; `listingImageOrder` says in what order they
// go, so the main photograph is the same on every product in the batch. A
// wrong ordering silently sends the wrong image as the Printify main photo,
// which is exactly the class of disagreement these helpers exist to prevent.
// ---------------------------------------------------------------------------

function sessionWith(order: string[], images: Record<string, string[]> = {}): StudioSession {
  return { ...emptySession(), listingImageOrder: order, listingImages: images };
}

function mockup(fields: Partial<Mockup> & Pick<Mockup, "id" | "name" | "category">): Mockup {
  return {
    tags: [],
    favorite: false,
    assetId: `asset-${fields.id}`,
    width: 1000,
    height: 1000,
    source: "user",
    ...fields,
  } as Mockup;
}

describe("applyGlobalOrder", () => {
  it("returns the ids unchanged when no order is stored", () => {
    const session = sessionWith([]);
    expect(applyGlobalOrder(session, ["b", "a"])).toEqual(["b", "a"]);
  });

  it("puts the ordered ids first, in their stored order", () => {
    const session = sessionWith(["c", "a", "b"]);
    expect(applyGlobalOrder(session, ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });

  it("appends mockups that are not in the stored order yet (new uploads)", () => {
    // A mockup uploaded after the drag must not steal the main-image slot.
    const session = sessionWith(["b", "a"]);
    expect(applyGlobalOrder(session, ["a", "b", "new"])).toEqual(["b", "a", "new"]);
  });

  it("skips an ordered id the caller did not pass, without reserving a slot", () => {
    // An excluded mockup is skipped - the remaining ids still keep order 1..n.
    const session = sessionWith(["b", "a", "excluded"]);
    expect(applyGlobalOrder(session, ["a", "b"])).toEqual(["b", "a"]);
  });

  it("is harmless when the stored order holds duplicate ids", () => {
    // The send pipeline may write the order twice; the FIRST rank wins.
    const session = sessionWith(["a", "b", "a"]);
    expect(applyGlobalOrder(session, ["b", "a"])).toEqual(["a", "b"]);
  });

  it("orders an empty list to an empty list", () => {
    expect(applyGlobalOrder(sessionWith(["a"]), [])).toEqual([]);
  });
});

describe("mergeGlobalOrder", () => {
  it("keeps a hidden id's relative position at the end", () => {
    // A row that hides some mockups (a different category filter) still drags;
    // the ids it cannot see must not lose their slot.
    expect(mergeGlobalOrder(sessionWith(["a", "b", "c"]), ["c"])).toEqual(["c", "a", "b"]);
  });

  it("persists a brand-new id in front of the previously ordered ones", () => {
    expect(mergeGlobalOrder(sessionWith(["a", "b"]), ["new", "a"])).toEqual(["new", "a", "b"]);
  });

  it("stores a first drag with no previous order", () => {
    expect(mergeGlobalOrder(sessionWith([]), ["b", "a"])).toEqual(["b", "a"]);
  });

  it("keeps the dragged list verbatim in front of the hidden rest", () => {
    // Reorder never emits duplicates, so the helper stores what it is given
    // rather than paying for a dedupe pass it does not need.
    expect(mergeGlobalOrder(sessionWith(["a"]), ["b", "b", "a"])).toEqual(["b", "b", "a"]);
  });
});

describe("listingMockupIds", () => {
  it("never invents a selection for a listing that was never configured", () => {
    // An empty answer is NOT "every mockup": the views decide the default, and
    // an explicit Clear must stay empty.
    expect(listingMockupIds(sessionWith(["a"]), "listing-1")).toEqual([]);
  });

  it("returns the explicit selection in the global order", () => {
    const session = sessionWith(["b", "a"], { "listing-1": ["a", "b"] });
    expect(listingMockupIds(session, "listing-1")).toEqual(["b", "a"]);
  });

  it("keeps an explicit empty selection empty (a deliberate Clear)", () => {
    const session = sessionWith(["a"], { "listing-1": [] });
    expect(listingMockupIds(session, "listing-1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Info cards live in the same `mockups` table, so every PRODUCT surface has to
// filter them out or an info card would end up as a Printify main image.
// ---------------------------------------------------------------------------

describe("product and info-card filtering", () => {
  const library = [
    mockup({ id: "m1", name: "front", category: "tshirt" }),
    mockup({ id: "card", name: "size chart", category: "tshirt", kind: "info-card", infoCardOrder: 2 }),
    mockup({ id: "card2", name: "what you get", category: "tshirt", kind: "info-card", infoCardOrder: 1 }),
    mockup({ id: "m2", name: "back", category: "tshirt", kind: "product" }),
  ];

  it("keeps only product mockups, absent kind included", () => {
    expect(productMockups(library).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("returns only the info cards, sorted by infoCardOrder", () => {
    // Even the bare filter keeps the strip order stable, so every surface
    // that reads it shows the same sequence.
    expect(infoCardMockups(library).map((m) => m.id)).toEqual(["card2", "card"]);
  });

  it("gives the cards of ONE category, sorted by infoCardOrder", () => {
    const cards = infoCardsForCategory(library, "tshirt");
    expect(cards.map((m) => m.id)).toEqual(["card2", "card"]);
  });

  it("gives no cards for a category that has none", () => {
    expect(infoCardsForCategory(library, "mug")).toEqual([]);
  });
});

describe("infoCardsForListing", () => {
  const library = [
    mockup({ id: "m1", name: "front", category: "tshirt", createdAt: 1 }),
    mockup({ id: "mug", name: "mug front", category: "mug", createdAt: 2 }),
    mockup({ id: "card", name: "tshirt size chart", category: "tshirt", kind: "info-card", infoCardOrder: 2, createdAt: 3 }),
    mockup({ id: "card2", name: "tshirt what you get", category: "tshirt", kind: "info-card", infoCardOrder: 1, createdAt: 4 }),
    mockup({ id: "mugcard", name: "mug care sheet", category: "mug", kind: "info-card", infoCardOrder: 1, createdAt: 5 }),
  ];

  it("attaches the cards of the included mockups' categories", () => {
    expect(infoCardsForListing(library, ["m1"]).map((m) => m.id)).toEqual(["card2", "card"]);
  });

  it("attaches the union when the inclusion spans categories", () => {
    expect(infoCardsForListing(library, ["m1", "mug"]).map((m) => m.id)).toEqual([
      "card2",
      "mugcard",
      "card",
    ]);
  });

  it("attaches nothing when the listing includes no product mockup", () => {
    expect(infoCardsForListing(library, [])).toEqual([]);
  });

  it("ignores info cards in the inclusion list itself", () => {
    expect(infoCardsForListing(library, ["card"])).toEqual([]);
  });

  it("does not need the Printify catalogue when no product name is known", () => {
    // The point of the rule: a missing catalogue (no API key) must still
    // attach the right cards, from the mockup categories alone.
    expect(infoCardsForListing(library, ["m1", "mug"]).map((m) => m.name)).toContain("mug care sheet");
  });
});

describe("sub-categories", () => {
  it("defaults to Default so existing mockups need no migration", () => {
    expect(subCategoryOf(mockup({ id: "m1", name: "front", category: "tshirt" }))).toBe(
      DEFAULT_SUBCATEGORY,
    );
  });

  it("lists Default first and dedupes a named template", () => {
    const names = subCategoriesFor(
      [
        mockup({ id: "m1", name: "front", category: "tshirt", subCategory: "Hanging" }),
        mockup({ id: "m2", name: "back", category: "tshirt" }),
        mockup({ id: "m3", name: "other", category: "tshirt", subCategory: "Hanging" }),
      ],
      "tshirt",
      "product",
    );
    expect(names).toEqual([DEFAULT_SUBCATEGORY, "Hanging"]);
  });

  it("maps a product title to the mockup category it belongs to", () => {
    expect(mockupCategoryForTitle("Unisex Jersey T-Shirt")).toBe("tshirt");
    expect(mockupCategoryForTitle("Ceramic Mug")).toBe("mug");
    expect(mockupCategoryForTitle("Something Unmapped")).toBeUndefined();
  });
});
