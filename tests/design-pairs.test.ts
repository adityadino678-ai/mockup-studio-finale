import { describe, expect, it } from "vitest";
import {
  designPairForDesign,
  planDesignPairColours,
  setDesignPairRole,
  withDesignPair,
  withoutDesignPair,
} from "@/lib/printify/design-colours";
import { buildStudioPlan, studioPlanProblems } from "@/lib/printify/studio-plan";
import { buildStudioListings, listingSelectionIds } from "@/lib/printify/listing-plan";
import { emptySession } from "@/lib/printify/studio-session";
import type { CatalogVariant } from "@/lib/printify/types";
import type { Design, StudioSession } from "@/types/domain";

function design(id: string, createdAt = 1000): Design {
  return {
    id,
    name: id,
    originalAssetId: `asset-${id}`,
    createdAt,
  } as unknown as Design;
}

/** Two colours on the plain panel, two catalogue variants per colour. */
const CATALOGUE: CatalogVariant[] = [
  { id: 11, title: "Red / M", options: { color: "Red", size: "M" }, placeholders: [{ position: "front" }, { position: "back" }] },
  { id: 12, title: "Red / L", options: { color: "Red", size: "L" }, placeholders: [{ position: "front" }, { position: "back" }] },
  { id: 21, title: "Blue / M", options: { color: "Blue", size: "M" }, placeholders: [{ position: "front" }, { position: "back" }] },
  { id: 22, title: "Blue / L", options: { color: "Blue", size: "L" }, placeholders: [{ position: "front" }, { position: "back" }] },
] as unknown as CatalogVariant[];

function session(overrides: Partial<StudioSession> = {}): StudioSession {
  return {
    ...emptySession(),
    blueprintId: 1,
    printProviderId: 1,
    designIds: ["front", "back"],
    rows: {
      plain: { colors: ["Red", "Blue"], blackInkColors: [], whiteInkColors: [] },
      ink: emptySession().rows.ink,
    },
    ...overrides,
  } as StudioSession;
}

describe("design pair helpers", () => {
  it("finds a design's pair and its side", () => {
    const pairs = withDesignPair([], "a", "b");
    expect(designPairForDesign(pairs, "a")).toMatchObject({ role: "front" });
    expect(designPairForDesign(pairs, "b")).toMatchObject({ role: "back" });
    expect(designPairForDesign(pairs, "c")).toBeUndefined();
  });

  it("replaces a pair either design was already in", () => {
    const pairs = withDesignPair(withDesignPair([], "a", "b"), "b", "c");
    expect(pairs).toEqual([{ frontDesignId: "b", backDesignId: "c" }]);
  });

  it("drops the whole pair from either half", () => {
    const pairs = withDesignPair([], "a", "b");
    expect(withoutDesignPair(pairs, "b")).toEqual([]);
  });

  it("swaps sides", () => {
    const pairs = setDesignPairRole(withDesignPair([], "a", "b"), "a", "back");
    expect(pairs).toEqual([{ frontDesignId: "b", backDesignId: "a" }]);
  });
});

describe("planDesignPairColours", () => {
  it("both halves print the PLAIN panel's colours with the main artwork", () => {
    const plan = planDesignPairColours({
      plain: ["Red", "Blue"],
      ink: ["White"],
      blackInk: ["White"],
      whiteInk: [],
    });
    expect(plan.groups).toEqual([{ ink: "main", colors: ["Red", "Blue"] }]);
    expect(plan.colors).toEqual(["Red", "Blue"]);
    expect(plan.missing).toEqual([]);
    expect(plan.undecided).toEqual([]);
    expect(plan.usesInkArtwork).toBe(false);
  });
});

describe("listingSelectionIds - the pre-pairing selection repair", () => {
  const pairListing = {
    listingId: "front",
    memberIds: ["front", "back"],
    memberArtworkIds: { front: "asset-front", back: "asset-back" },
  } as Parameters<typeof listingSelectionIds>[1];

  it("expands a pair's PRE-PAIRING bare mockup ids to both members' tiles", () => {
    const stored = { listingImages: { front: ["m1", "m2"] } } as never;
    expect(listingSelectionIds(stored, pairListing)).toEqual([
      "front:m1",
      "back:m1",
      "front:m2",
      "back:m2",
    ]);
  });

  it("keeps proper tile ids and drops tiles naming a non-member design", () => {
    const stored = {
      listingImages: { front: ["front:m1", "stranger:m1", "back:m2"] },
    } as never;
    expect(listingSelectionIds(stored, pairListing)).toEqual(["front:m1", "back:m2"]);
  });

  it("leaves an ordinary listing's stored ids untouched", () => {
    const stored = { listingImages: { solo: ["m1", "m2"] } } as never;
    expect(
      listingSelectionIds(stored, {
        listingId: "solo",
        memberIds: ["solo"],
        artworkAssetId: "asset-solo",
      } as Parameters<typeof listingSelectionIds>[1]),
    ).toEqual(["m1", "m2"]);
  });

  it("answers empty for a listing with no stored selection", () => {
    expect(listingSelectionIds({} as never, pairListing)).toEqual([]);
  });
});

describe("buildStudioPlan - a design pair", () => {
  const active = session({
    designPairs: [{ frontDesignId: "front", backDesignId: "back" }],
  });

  it("creates ONE item for the pair with a group per side", () => {
    const plan = buildStudioPlan([design("front", 1000), design("back", 2000)], active, CATALOGUE);
    expect(plan).not.toBeNull();
    expect(plan!.items).toHaveLength(1);
    const item = plan!.items[0];
    expect(item.designId).toBe("front");
    expect(item.memberIds).toEqual(["front", "back"]);
    expect(item.partnerDesignId).toBe("back");
    expect(item.row).toBe("plain");
    expect(item.groups).toHaveLength(2);
    expect(item.groups[0]).toMatchObject({
      ink: "main",
      assetId: "asset-front",
      position: "front",
      designId: "front",
      colors: ["Red", "Blue"],
    });
    expect(item.groups[1]).toMatchObject({
      ink: "main",
      assetId: "asset-back",
      position: "back",
      designId: "back",
      colors: ["Red", "Blue"],
    });
  });

  it("is recognised as a sided pair item and reports no partition problems", () => {
    const plan = buildStudioPlan([design("front", 1000), design("back", 2000)], active, CATALOGUE);
    expect(studioPlanProblems(plan!, [design("front", 1000), design("back", 2000)], active)).toEqual([]);
  });

  it("blocks an EMPTY plain panel with a message that names both designs", () => {
    const empty = session({
      designPairs: [{ frontDesignId: "front", backDesignId: "back" }],
      rows: {
        plain: { colors: [], blackInkColors: [], whiteInkColors: [] },
        ink: emptySession().rows.ink,
      },
    });
    const plan = buildStudioPlan([design("front", 1000), design("back", 2000)], empty, CATALOGUE);
    const problems = studioPlanProblems(plan!, [design("front", 1000), design("back", 2000)], empty);
    expect(problems.some((p) => p.includes('"front"') && p.includes('"back"') && p.includes("No ink variants"))).toBe(true);
  });

  it("blocks a pair that overlaps an ink pair", () => {
    const both = session({
      inkPairs: [{ blackInkDesignId: "front", whiteInkDesignId: "back" }],
      designPairs: [{ frontDesignId: "front", backDesignId: "back" }],
      rows: {
        plain: { colors: ["Red", "Blue"], blackInkColors: [], whiteInkColors: [] },
        ink: { colors: ["Red"], blackInkColors: ["Red"], whiteInkColors: [] },
      },
    });
    const plan = buildStudioPlan([design("front", 1000), design("back", 2000)], both, CATALOGUE);
    const problems = studioPlanProblems(plan!, [design("front", 1000), design("back", 2000)], both);
    expect(problems.some((p) => p.includes("both an ink pair and a design pair"))).toBe(true);
  });
});

describe("buildStudioListings - a design pair", () => {
  it("is ONE listing owned by the front half, covering both designs' artwork", () => {
    const active = session({
      designPairs: [{ frontDesignId: "front", backDesignId: "back" }],
    });
    const listings = buildStudioListings([design("front", 1000), design("back", 2000)], active);
    expect(listings).toHaveLength(1);
    const listing = listings[0];
    expect(listing.listingId).toBe("front");
    expect(listing.memberIds).toEqual(["front", "back"]);
    expect(listing.partnerDesignId).toBe("back");
    expect(listing.row).toBe("plain");
    expect(listing.memberArtworkIds).toEqual({
      front: "asset-front",
      back: "asset-back",
    });
  });
});
