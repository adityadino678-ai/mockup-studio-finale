import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import { saveStudioListingDrafts } from "@/lib/printify/listing-drafts";
import { emptySession } from "@/lib/printify/studio-session";
import type { StudioListing } from "@/lib/printify/listing-plan";
import type { ListingDraft, StudioSession } from "@/types/domain";

/**
 * Copy preservation is what makes per-design editing real.
 *
 * The Listing details page writes a design's own title/description/tags - but
 * three OTHER code paths save the same drafts for reasons that have nothing to
 * do with copy (image selections, a placement fix, product creation). If those
 * incidental saves regenerate from the batch templates, every per-design edit
 * is silently thrown away the next time the user touches an image.
 *
 * `copyMode` is the explicit answer: `regenerate` (details page) makes the
 * templates/form the source of truth, `preserve` (everything else, and the
 * default) keeps what the user already wrote for that design.
 */

const listingA: StudioListing = {
  listingId: "d-a",
  designId: "d-a",
  designName: "Anchor",
  row: "plain",
  memberIds: ["d-a"],
  artworkAssetId: "art-a",
};

const listingB: StudioListing = {
  listingId: "d-b",
  designId: "d-b",
  designName: "Buoy",
  row: "plain",
  memberIds: ["d-b"],
  artworkAssetId: "art-b",
};

function session(overrides: Partial<StudioSession> = {}): StudioSession {
  return {
    ...emptySession(),
    titleTemplate: "{design} shirt",
    descriptionTemplate: "A shirt for {design}",
    tags: ["shirt", "gift"],
    category: "Apparel",
    quantity: 2,
    priceCents: 2499,
    ...overrides,
  };
}

async function draftFor(designId: string): Promise<ListingDraft> {
  const rows = await db.listingDrafts.where("designId").equals(designId).toArray();
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Simulates the Listing details page's per-design save. */
async function writePerDesignCopy(designId: string, title: string) {
  const draft = await draftFor(designId);
  await db.listingDrafts.put({
    ...draft,
    title,
    description: `${title} - hand written`,
    tags: ["one-off"],
    category: "Home",
    quantity: 7,
  });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe("saveStudioListingDrafts copyMode", () => {
  it("seeds a first save from the templates in either mode", async () => {
    const saved = await saveStudioListingDrafts({
      session: session(),
      listings: [listingA],
      productName: "Tee",
      copyMode: "preserve",
    });
    expect(saved).toEqual({ created: 1, updated: 0, saved: 1 });

    const draft = await draftFor("d-a");
    expect(draft.title).toBe("Anchor shirt");
    expect(draft.description).toBe("A shirt for Anchor");
    expect(draft.tags).toEqual(["shirt", "gift"]);
    expect(draft.category).toBe("Apparel");
    expect(draft.quantity).toBe(2);
  });

  it("preserve keeps per-design copy that an incidental save did not edit", async () => {
    await saveStudioListingDrafts({
      session: session(),
      listings: [listingA, listingB],
      productName: "Tee",
      copyMode: "regenerate",
    });
    await writePerDesignCopy("d-a", "One of a kind");

    // What Listing images / placement / product creation do: save drafts
    // without touching copy.
    await saveStudioListingDrafts({
      session: session({ titleTemplate: "CHANGED {design}" }),
      listings: [listingA, listingB],
      productName: "Tee",
    });

    const a = await draftFor("d-a");
    expect(a.title).toBe("One of a kind");
    expect(a.description).toBe("One of a kind - hand written");
    expect(a.tags).toEqual(["one-off"]);
    expect(a.category).toBe("Home");
    expect(a.quantity).toBe(7);

    // An incidental save never regenerates copy, not even for a design the
    // user did not edit: changing every draft's copy is exactly what the
    // Listing details page's "Apply to every design" is for.
    const b = await draftFor("d-b");
    expect(b.title).toBe("Buoy shirt");
  });

  it("regenerate makes the templates win for every listing it is given", async () => {
    await saveStudioListingDrafts({
      session: session(),
      listings: [listingA, listingB],
      productName: "Tee",
      copyMode: "regenerate",
    });
    await writePerDesignCopy("d-a", "One of a kind");

    await saveStudioListingDrafts({
      session: session({ titleTemplate: "Batch {design}" }),
      listings: [listingA],
      productName: "Tee",
      copyMode: "regenerate",
    });

    const a = await draftFor("d-a");
    expect(a.title).toBe("Batch Anchor");
    expect(a.description).toBe("A shirt for Anchor");
    expect(a.tags).toEqual(["shirt", "gift"]);
    expect(a.category).toBe("Apparel");
    expect(a.quantity).toBe(2);

    // A regenerate for one listing must not rewrite the other design's draft.
    expect((await draftFor("d-b")).title).toBe("Buoy shirt");
  });

  it("preserve still writes images, price and remote links", async () => {
    await saveStudioListingDrafts({
      session: session(),
      listings: [listingA],
      productName: "Tee",
      copyMode: "regenerate",
    });
    await writePerDesignCopy("d-a", "Kept");

    await saveStudioListingDrafts({
      session: session({
        priceMode: "custom",
        listingPrices: { "d-a": 3199 },
        listingImageCleared: { "d-a": true },
      }),
      listings: [listingA],
      productName: "Tee",
      copyMode: "preserve",
    });

    const draft = await draftFor("d-a");
    expect(draft.title).toBe("Kept");
    expect(draft.priceCents).toBe(3199);
    expect(draft.imageAssetIds).toEqual([]);
    expect(draft.imageSelectionLocked).toBe(true);
  });
});
