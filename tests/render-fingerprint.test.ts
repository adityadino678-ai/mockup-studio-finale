import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db/schema";
import { renderComposition } from "@/lib/batch/runner";
import {
  computeRenderFingerprint,
  listingImageFingerprint,
  renderListingMockup,
  resolveRenderPlanWithFingerprint,
} from "@/lib/printify/listing-render";
import type { StudioListing } from "@/lib/printify/listing-plan";
import type {
  AssetMeta,
  Design,
  Mockup,
  MockupCategory,
  MockupPrintArea,
  StudioPlacement,
  Transform,
} from "@/types/domain";
import { DEFAULT_TRANSFORM } from "@/types/domain";

// ---------------------------------------------------------------------------
// The unit environment has no canvas (tests/setup.ts makes createImageBitmap
// throw), so the pixel half of `renderComposition` cannot run here. What these
// tests pin is the STORAGE half: the decode/compose boundary is stubbed, and
// everything else — the mockup read, the blob reads, the asset write and the
// fingerprint merge — runs for real against fake-indexeddb.
// ---------------------------------------------------------------------------
vi.mock("@/lib/image/image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image/image")>();
  // fake-indexeddb cannot round-trip a real (jsdom) Blob; a size-only stand-in
  // is enough because nothing below decodes it.
  const standIn = { size: 4, type: "image/png" } as unknown as Blob;
  return {
    ...actual,
    decodeImage: async () =>
      ({ width: 8, height: 8, close: () => {} }) as unknown as ImageBitmap,
    getImageInfo: async () => ({ width: 8, height: 8, hasAlpha: true }),
    makeThumbnail: async () => standIn,
    canvasToBlob: async () => standIn,
  };
});
vi.mock("@/lib/canvas/compose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/canvas/compose")>()),
  composeToCanvas: () => ({ width: 8, height: 8 }),
}));

// Same fixtures as tests/placement-coherence.test.ts.
const FRAME = { x: 0.5, y: 0.42, scale: 0.32, rotation: 0 };

function area(overrides: Partial<MockupPrintArea> = {}): MockupPrintArea {
  return {
    areaWidth: 1200,
    areaHeight: 1600,
    source: { kind: "preset", presetId: "dtg-front" },
    label: "Front",
    frame: { ...FRAME },
    clipMode: "area",
    updatedAt: 1,
    ...overrides,
  };
}

function mockup(
  id: string,
  category: MockupCategory,
  printArea?: MockupPrintArea,
): Mockup {
  return {
    id,
    name: id,
    category,
    tags: [],
    favorite: false,
    assetId: `asset-${id}`,
    width: 1000,
    height: 1250,
    source: "user",
    printArea,
    createdAt: 1,
  };
}

const placement = (scale: number, angle = 0): StudioPlacement => ({
  position: "front",
  x: 0.5,
  y: 0.5,
  scale,
  angle,
});

const listing: StudioListing = {
  listingId: "l1",
  designId: "d1",
  designName: "Cat",
  row: "plain",
  memberIds: ["d1"],
  artworkAssetId: "art",
};

const design: Design = {
  id: "d1",
  name: "Cat",
  tags: [],
  originalAssetId: "art",
  activeVariant: "main",
  createdAt: 1,
  updatedAt: 1,
};

/** Reads the stored asset with the fingerprint field the tests assert on. */
async function storedAsset(assetId: string) {
  const stored = await db.assets.get(assetId);
  return stored as (AssetMeta & { renderFp?: string }) | undefined;
}

/** Seeds the rows a real renderComposition call reads: design, mockup, blobs. */
async function seedRenderSources() {
  await db.designs.put(design);
  await db.mockups.put(mockup("m1", "tshirt", area()));
  await db.blobs.put({ id: "asset-m1", blob: { size: 10 } as unknown as Blob });
  await db.blobs.put({ id: "art", blob: { size: 10 } as unknown as Blob });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe("resolveRenderPlanWithFingerprint", () => {
  it("produces the SAME fingerprint as the listing path from one snapshot", async () => {
    const withArea = mockup("m1", "tshirt", area());
    const place = placement(0.6, 8);

    const { fp } = await resolveRenderPlanWithFingerprint({
      designId: "d1",
      designAssetId: listing.artworkAssetId,
      mockup: withArea,
      placementOverride: place,
    });

    // The listing path with no saved placement row hashes the same inputs.
    expect(fp).toBe(
      listingImageFingerprint({ listing, mockup: withArea, placement: place }),
    );
    // And the shared helper agrees directly — one source of the hash.
    expect(fp).toBe(
      computeRenderFingerprint({
        designAssetId: listing.artworkAssetId,
        mockup: withArea,
        placement: place,
      }),
    );
  });

  it("agrees with the listing path when the mockup has no print area", async () => {
    const bare = mockup("m1", "tshirt");
    const place = placement(0.4);
    const fallback: Transform = {
      x: 0.25,
      y: 0.35,
      scale: 0.2,
      rotation: 4,
      flipX: false,
      flipY: false,
      opacity: 1,
      stretch: 1,
    };

    const { fp } = await resolveRenderPlanWithFingerprint({
      designId: "d1",
      designAssetId: listing.artworkAssetId,
      mockup: bare,
      placementOverride: place,
      fallbackTransform: fallback,
      behindMockup: true,
    });

    expect(fp).toBe(
      listingImageFingerprint({
        listing,
        mockup: bare,
        placement: place,
        saved: { transform: fallback, behindMockup: true },
      }),
    );
  });

  it("matches the fingerprint a full listing render computes and stores", async () => {
    const withArea = mockup("m1", "tshirt", area());
    const place = placement(0.55);
    await seedRenderSources();

    const { fp } = await resolveRenderPlanWithFingerprint({
      designId: "d1",
      designAssetId: listing.artworkAssetId,
      mockup: withArea,
      placementOverride: place,
    });

    const { assetId, fingerprint } = await renderListingMockup({
      listing,
      design,
      mockup: withArea,
      placement: place,
    });

    expect(fingerprint).toBe(fp);
    // The render asset itself carries the fingerprint it was made with.
    expect((await storedAsset(assetId))?.renderFp).toBe(fp);
  });
});

describe("computeRenderFingerprint", () => {
  const areaMockup = (overrides: Partial<MockupPrintArea> = {}) =>
    mockup("m1", "tshirt", area(overrides));

  const fpOf = (
    m: Mockup,
    place: StudioPlacement = placement(0.5),
    extra: {
      fallbackTransform?: Transform | null;
      behindMockup?: boolean | null;
    } = {},
  ) => computeRenderFingerprint({ designAssetId: "art", mockup: m, placement: place, ...extra });

  it("changes when any pixel-affecting field changes", () => {
    const start = fpOf(areaMockup());

    // The frame carrying the area.
    expect(fpOf(areaMockup({ frame: { ...FRAME, x: 0.52 } }))).not.toBe(start);
    expect(fpOf(areaMockup({ frame: { ...FRAME, y: 0.44 } }))).not.toBe(start);
    expect(fpOf(areaMockup({ frame: { ...FRAME, scale: 0.3 } }))).not.toBe(start);
    expect(fpOf(areaMockup({ frame: { ...FRAME, rotation: 3 } }))).not.toBe(start);
    // The area's size and its visible window.
    expect(fpOf(areaMockup({ areaWidth: 1300 }))).not.toBe(start);
    expect(fpOf(areaMockup({ areaHeight: 1700 }))).not.toBe(start);
    expect(
      fpOf(areaMockup({ crop: { x: 0, y: 0, width: 1, height: 0.6 } })),
    ).not.toBe(start);
    expect(fpOf(areaMockup({ clipMode: "behind-garment" }))).not.toBe(start);
    // The Studio placement.
    expect(fpOf(areaMockup(), { ...placement(0.5), x: 0.52 })).not.toBe(start);
    expect(fpOf(areaMockup(), { ...placement(0.5), y: 0.48 })).not.toBe(start);
    expect(fpOf(areaMockup(), placement(0.55))).not.toBe(start);
    expect(fpOf(areaMockup(), placement(0.5, 10))).not.toBe(start);
    // The behind-garment override and everything about the artwork and photo.
    expect(fpOf(areaMockup(), placement(0.5), { behindMockup: true })).not.toBe(start);
    expect(fpOf({ ...areaMockup(), assetId: "asset-other" })).not.toBe(start);
    expect(fpOf({ ...areaMockup(), width: 1200 })).not.toBe(start);
    expect(
      computeRenderFingerprint({
        designAssetId: "art-2",
        mockup: areaMockup(),
        placement: placement(0.5),
      }),
    ).not.toBe(start);
  });

  it("hashes the fallback transform only when there is no print area", async () => {
    const saved: Transform = { ...DEFAULT_TRANSFORM, x: 0.3, y: 0.4 };
    const bare = mockup("m1", "tshirt");

    // No print area: the saved transform is an input, so changing it changes
    // the fingerprint.
    const noArea = (transform: Transform | null) =>
      computeRenderFingerprint({
        designAssetId: "art",
        mockup: bare,
        placement: placement(0.5),
        fallbackTransform: transform,
      });
    expect(noArea(saved)).not.toBe(noArea(DEFAULT_TRANSFORM));

    // With a print area the saved transform is NOT an input: the listing path
    // and the convenience both hash `null` there, whatever the caller saved.
    const withAreaListing = (row: { transform: Transform } | null) =>
      listingImageFingerprint({
        listing,
        mockup: areaMockup(),
        placement: placement(0.5),
        saved: row,
      });
    expect(withAreaListing({ transform: saved })).toBe(withAreaListing(null));

    const withAreaPlan = (fallback: Transform | undefined) =>
      resolveRenderPlanWithFingerprint({
        designId: "d1",
        designAssetId: "art",
        mockup: areaMockup(),
        placementOverride: placement(0.5),
        fallbackTransform: fallback,
      });
    expect((await withAreaPlan(saved)).fp).toBe(
      (await withAreaPlan(DEFAULT_TRANSFORM)).fp,
    );
  });

  it("ignores label, source, reference and updatedAt", () => {
    const start = fpOf(areaMockup());
    const cosmetic = areaMockup({
      label: "Back",
      source: { kind: "preset", presetId: "something-else" },
      reference: { label: "Chest", inches: 20, pixelsPerInch: 50 },
      updatedAt: 99,
    });

    expect(fpOf(cosmetic)).toBe(start);
  });
});

describe("renderComposition renderFp storage", () => {
  const renderCall = (renderFp?: string) => ({
    designId: "d1",
    mockupId: "m1",
    designAssetId: "art",
    transform: { ...DEFAULT_TRANSFORM },
    clip: null,
    behindMockup: false,
    ...(renderFp !== undefined ? { renderFp } : {}),
  });

  it("stores a passed renderFp on the asset meta", async () => {
    await seedRenderSources();

    const assetId = await renderComposition({ ...renderCall("fp-abc") });

    const stored = await storedAsset(assetId);
    expect(stored?.kind).toBe("mockup-render");
    expect(stored?.sourceDesignId).toBe("d1");
    expect(stored?.sourceMockupId).toBe("m1");
    expect(stored?.parentId).toBe("art");
    expect(stored?.renderFp).toBe("fp-abc");
  });

  it("writes no renderFp when the caller does not pass one", async () => {
    await seedRenderSources();

    const assetId = await renderComposition(renderCall());

    const stored = await storedAsset(assetId);
    expect(stored).toBeDefined();
    expect(stored?.renderFp).toBeUndefined();
    // Old behaviour: the field is absent from the record, not present-but-
    // undefined, so every pre-existing asset record is unchanged.
    expect(Object.keys(stored ?? {})).not.toContain("renderFp");
  });
});
