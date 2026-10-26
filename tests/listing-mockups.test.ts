import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import {
  appliedMockupRecord,
  listingMockupSignature,
  mockupsAlreadyApplied,
  withAppliedMockups,
} from "@/lib/printify/listing-mockups";
import {
  emptySession,
  loadSession,
  saveSession,
} from "@/lib/printify/studio-session";
import type { StudioListingMockupsApplied, StudioSession } from "@/types/domain";

// ---------------------------------------------------------------------------
// The "already applied" signature is what makes a copy/price-only Send skip
// the expensive upload/apply stage. A false positive would silently leave old
// images on Printify, so every input that changes the pixels must change it.
// ---------------------------------------------------------------------------

const images = [
  { mockupId: "m1", fingerprint: "fp-1" },
  { mockupId: "m2", fingerprint: "fp-2" },
];

function sessionWith(
  listingId: string,
  record: StudioListingMockupsApplied,
): StudioSession {
  return {
    ...emptySession(),
    listingMockupsApplied: { [listingId]: record },
  };
}

describe("the applied-mockup signature", () => {
  it("is stable for the same product, order and fingerprints", () => {
    const first = listingMockupSignature("p1", images);
    const second = listingMockupSignature("p1", [
      { mockupId: "m1", fingerprint: "fp-1" },
      { mockupId: "m2", fingerprint: "fp-2" },
    ]);
    expect(first).toBe(second);
    expect(first).toContain("p1");
  });

  it("changes when the product changes", () => {
    expect(listingMockupSignature("p2", images)).not.toBe(
      listingMockupSignature("p1", images),
    );
  });

  it("changes when an image is added, removed, reordered or re-rendered", () => {
    const base = listingMockupSignature("p1", images);
    expect(
      listingMockupSignature("p1", [...images, { mockupId: "m3", fingerprint: "fp-3" }]),
    ).not.toBe(base);
    expect(listingMockupSignature("p1", images.slice(0, 1))).not.toBe(base);
    expect(listingMockupSignature("p1", [...images].reverse())).not.toBe(base);
    expect(
      listingMockupSignature("p1", [
        { mockupId: "m1", fingerprint: "fp-1-changed" },
        images[1],
      ]),
    ).not.toBe(base);
  });

  it("records the product, signature and time together", () => {
    const record = appliedMockupRecord("p1", images, 1234);
    expect(record).toEqual({
      productId: "p1",
      signature: listingMockupSignature("p1", images),
      appliedAt: 1234,
    });
  });
});

describe("the already-applied guard", () => {
  it("is false without a signature or a record", () => {
    const session = emptySession();
    const signature = listingMockupSignature("p1", images);
    expect(mockupsAlreadyApplied(session, "listing-1", "p1", undefined)).toBe(false);
    expect(mockupsAlreadyApplied(session, "listing-1", "p1", signature)).toBe(false);
  });

  it("is true only for the exact listing, product and signature", () => {
    const record = appliedMockupRecord("p1", images, 1234);
    const session = sessionWith("listing-1", record);
    expect(mockupsAlreadyApplied(session, "listing-1", "p1", record.signature)).toBe(true);
    expect(mockupsAlreadyApplied(session, "listing-2", "p1", record.signature)).toBe(false);
    expect(mockupsAlreadyApplied(session, "listing-1", "p2", record.signature)).toBe(false);
    expect(
      mockupsAlreadyApplied(
        session,
        "listing-1",
        "p1",
        listingMockupSignature("p1", [...images].reverse()),
      ),
    ).toBe(false);
  });
});

describe("merging applied records into the session", () => {
  it("returns the same session when there is nothing to merge", () => {
    const session = emptySession();
    expect(withAppliedMockups(session, {})).toBe(session);
  });

  it("merges without mutating the input or dropping other listings", () => {
    const first = appliedMockupRecord("p1", images, 1);
    const second = appliedMockupRecord("p2", images, 2);
    const session = sessionWith("listing-1", first);
    const next = withAppliedMockups(session, { "listing-2": second });

    expect(next).not.toBe(session);
    expect(next.listingMockupsApplied).toEqual({
      "listing-1": first,
      "listing-2": second,
    });
    expect(session.listingMockupsApplied).toEqual({ "listing-1": first });
    expect(next.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
  });
});

describe("session persistence", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("round-trips the applied records through the stored session", async () => {
    const record = appliedMockupRecord("p1", images, 1234);
    await saveSession(sessionWith("listing-1", record));

    const loaded = await loadSession();
    expect(loaded.listingMockupsApplied).toEqual({ "listing-1": record });
  });

  it("drops malformed applied records instead of trusting them", async () => {
    await db.settings.put({
      key: "printifyStudio:session",
      value: {
        listingMockupsApplied: {
          good: { productId: "p1", signature: "sig", appliedAt: 5 },
          noProduct: { signature: "sig", appliedAt: 5 },
          noSignature: { productId: "p1", appliedAt: 5 },
          notAnObject: "nope",
        },
      },
    });

    const loaded = await loadSession();
    expect(loaded.listingMockupsApplied).toEqual({
      good: { productId: "p1", signature: "sig", appliedAt: 5 },
    });
  });
});
