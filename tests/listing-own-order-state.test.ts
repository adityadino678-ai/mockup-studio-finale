import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import {
  emptySession,
  loadSession,
  pruneStudioDesign,
  remapListingState,
  SESSION_KEY,
} from "@/lib/printify/studio-session";
import type { StudioSession } from "@/types/domain";

// ---------------------------------------------------------------------------
// The per-design "Own order" state (`listingImageOrders`) is optional, so old
// sessions load unchanged. These tests pin the three places the state can be
// stored, sanitised or destroyed: loadSession, pruneStudioDesign (a deleted
// design) and remapListingState (a pair's black/white swap).
// ---------------------------------------------------------------------------

/** Writes a partial session blob straight into the settings table. */
async function seedSession(partial: Record<string, unknown>): Promise<void> {
  const existing = await loadSession();
  await db.settings.put({ key: SESSION_KEY, value: { ...existing, ...partial } });
}

describe("listingImageOrders in the stored session", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("is an empty object on a fresh session", () => {
    expect(emptySession().listingImageOrders).toEqual({});
  });

  it("loads only string-array entries and drops entries with no usable ids", async () => {
    await seedSession({
      listingImageOrders: {
        "listing-1": ["m1", "m1", "m2"],
        "listing-2": [],
        "listing-3": [1, null, "m3"],
        "listing-4": "m1",
      },
    });

    const loaded = await loadSession();
    expect(loaded.listingImageOrders).toEqual({
      "listing-1": ["m1", "m2"],
      "listing-3": ["m3"],
    });
  });

  it("loads as an empty object when storage holds nothing usable", async () => {
    await seedSession({ listingImageOrders: "garbage" });
    const loaded = await loadSession();
    expect(loaded.listingImageOrders).toEqual({});
  });

  it("keeps every other session field untouched on load", async () => {
    await seedSession({
      listingImageOrder: ["m2", "m1"],
      listingImages: { other: ["m1"] },
      listingImageOrders: { detached: ["m1", "m2"] },
    });
    const loaded = await loadSession();
    expect(loaded.listingImageOrder).toEqual(["m2", "m1"]);
    expect(loaded.listingImages).toEqual({ other: ["m1"] });
  });

  it("pruneStudioDesign removes the deleted design's own order", async () => {
    await seedSession({
      listingImages: { gone: ["m1"], kept: ["m2"] },
      listingImageCleared: { gone: true },
      listingImageOrders: { gone: ["m1"], kept: ["m2"] },
    });

    await pruneStudioDesign("gone");

    const loaded = await loadSession();
    expect(loaded.listingImageOrders).toEqual({ kept: ["m2"] });
    expect(loaded.listingImages).toEqual({ kept: ["m2"] });
    expect(loaded.listingImageCleared).toEqual({});
  });

  it("remapListingState moves the own order to the pair's new black owner", () => {
    const session: StudioSession = {
      ...emptySession(),
      listingImages: { old: ["m1"], other: ["x"] },
      listingImageCleared: { old: true as const },
      listingImageOrders: { old: ["m1", "m2"], other: ["m2", "m1"] },
    };
    const patch = remapListingState(session, "old", "new");
    expect(patch.listingImageOrders).toEqual({ other: ["m2", "m1"], new: ["m1", "m2"] });
    // The other listings' entries are untouched.
    expect(patch.listingImages).toEqual({ other: ["x"], new: ["m1"] });
  });

  it("remapListingState leaves no own-order back-reference for the old owner", () => {
    const session: StudioSession = {
      ...emptySession(),
      listingImageOrders: { old: ["m1"] },
    };
    const patch = remapListingState(session, "old", "new");
    expect(Object.keys(patch.listingImageOrders ?? {})).toEqual(["new"]);
  });
});
