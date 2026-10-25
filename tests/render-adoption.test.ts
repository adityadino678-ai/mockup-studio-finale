import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import {
  adoptedRenderEntry,
  buildAdoptionIndex,
  buildSavedRenderIndex,
  findLatestSavedRender,
  latestSavedRenderIn,
  linkSavedRenderEntries,
  matchInAdoptionIndex,
  type LinkableRenderTarget,
} from "@/views/listings/render-adoption";
import type { AssetMeta } from "@/types/domain";

/**
 * Adoption is what lets the Listing images page show "the mockups we saved in
 * the Mockups panel" without re-rendering. The rule is deliberately narrow:
 * an asset is adoptable only when it is a mockup render, carries a recorded
 * fingerprint, names both source ids, and that fingerprint EQUALS the current
 * one. Anything less cannot prove what produced its pixels, so it is skipped
 * and the listing re-renders instead of guessing.
 */

function renderAsset(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    id: "asset-1",
    kind: "mockup-render",
    name: "design-shirt.png",
    mime: "image/png",
    width: 1000,
    height: 1000,
    size: 1234,
    createdAt: 1_000,
    parentId: "design-asset",
    sourceDesignId: "design-1",
    sourceMockupId: "mockup-1",
    renderFp: "fp-current",
    ...overrides,
  };
}

describe("buildAdoptionIndex", () => {
  it("groups renders by artwork asset and mockup", () => {
    const index = buildAdoptionIndex([
      renderAsset({ id: "a", renderFp: "fp-1" }),
      renderAsset({ id: "b", sourceMockupId: "mockup-2" }),
      renderAsset({ id: "c", parentId: "other-asset" }),
    ]);
    expect(index.get("design-asset:mockup-1")?.map((asset) => asset.id)).toEqual(["a"]);
    expect(index.get("design-asset:mockup-2")?.map((asset) => asset.id)).toEqual(["b"]);
    expect(index.get("other-asset:mockup-1")?.map((asset) => asset.id)).toEqual(["c"]);
  });

  it("skips anything that cannot prove what produced it", () => {
    const index = buildAdoptionIndex([
      renderAsset({ id: "no-fp", renderFp: undefined }),
      renderAsset({ id: "not-render", kind: "design-original" }),
      renderAsset({ id: "no-parent", parentId: undefined }),
      renderAsset({ id: "no-mockup", sourceMockupId: undefined }),
      renderAsset({ id: "ok" }),
    ]);
    expect(index.size).toBe(1);
    expect(index.get("design-asset:mockup-1")?.map((asset) => asset.id)).toEqual(["ok"]);
  });

  it("orders each bucket newest first so adoption prefers the latest pixels", () => {
    const index = buildAdoptionIndex([
      renderAsset({ id: "old", createdAt: 100, renderFp: "fp-old" }),
      renderAsset({ id: "new", createdAt: 300, renderFp: "fp-current" }),
      renderAsset({ id: "mid", createdAt: 200, renderFp: "fp-mid" }),
    ]);
    expect(index.get("design-asset:mockup-1")?.map((asset) => asset.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });
});

describe("matchInAdoptionIndex", () => {
  const index = buildAdoptionIndex([
    renderAsset({ id: "old-match", createdAt: 100, renderFp: "fp-current" }),
    renderAsset({ id: "newer-other", createdAt: 300, renderFp: "fp-stale" }),
  ]);

  it("returns the newest render whose fingerprint still matches", () => {
    const match = matchInAdoptionIndex(index, "design-asset", "mockup-1", "fp-current");
    expect(match?.id).toBe("old-match");
  });

  it("never adopts a render with a different fingerprint", () => {
    expect(matchInAdoptionIndex(index, "design-asset", "mockup-1", "fp-unknown")).toBeNull();
  });

  it("returns null for an unknown artwork or mockup", () => {
    expect(matchInAdoptionIndex(index, "other-asset", "mockup-1", "fp-current")).toBeNull();
    expect(matchInAdoptionIndex(index, "design-asset", "mockup-9", "fp-current")).toBeNull();
  });
});

describe("adoptedRenderEntry", () => {
  it("records the same bookkeeping shape a real render writes", () => {
    const asset = renderAsset({ id: "adopted", createdAt: 777 });
    expect(
      adoptedRenderEntry({
        asset,
        fingerprint: "fp-current",
        designId: "design-1",
        mockupId: "mockup-1",
      }),
    ).toEqual({
      assetId: "adopted",
      fingerprint: "fp-current",
      designId: "design-1",
      mockupId: "mockup-1",
      renderedAt: 777,
      source: "mockups",
    });
  });
});

describe("buildSavedRenderIndex", () => {
  it("keeps renders that carry no fingerprint, newest first", () => {
    const index = buildSavedRenderIndex([
      renderAsset({ id: "old", createdAt: 100, renderFp: "fp-old" }),
      renderAsset({ id: "new-no-fp", createdAt: 300, renderFp: undefined }),
      renderAsset({ id: "mid", createdAt: 200, renderFp: undefined }),
    ]);
    expect(index.get("design-asset:mockup-1")?.map((asset) => asset.id)).toEqual([
      "new-no-fp",
      "mid",
      "old",
    ]);
  });

  it("skips non-renders and records with no source ids", () => {
    const index = buildSavedRenderIndex([
      renderAsset({ id: "not-render", kind: "design-original" }),
      renderAsset({ id: "no-parent", parentId: undefined }),
      renderAsset({ id: "no-mockup", sourceMockupId: undefined }),
      renderAsset({ id: "ok", renderFp: undefined }),
    ]);
    expect(index.size).toBe(1);
    expect(latestSavedRenderIn(index, "design-asset", "mockup-1")?.id).toBe("ok");
  });

  it("still requires a fingerprint for automatic adoption", () => {
    const assets = [renderAsset({ id: "no-fp", renderFp: undefined })];
    // The normal index is unchanged: it cannot prove the pixels.
    expect(buildAdoptionIndex(assets).size).toBe(0);
    // The manual index can still find them.
    expect(latestSavedRenderIn(buildSavedRenderIndex(assets), "design-asset", "mockup-1")?.id).toBe(
      "no-fp",
    );
  });
});

describe("linkSavedRenderEntries", () => {
  const target = (overrides: Partial<LinkableRenderTarget> = {}): LinkableRenderTarget => ({
    key: "listing-1:mockup-1",
    artworkAssetId: "design-asset",
    designId: "design-1",
    mockupId: "mockup-1",
    fingerprint: "fp-current",
    covered: false,
    ...overrides,
  });

  it("links the newest saved render under the CURRENT fingerprint", () => {
    const index = buildSavedRenderIndex([
      renderAsset({ id: "old", createdAt: 100, renderFp: "fp-ancient" }),
      renderAsset({ id: "new", createdAt: 300, renderFp: undefined }),
    ]);

    expect(linkSavedRenderEntries(index, [target()])).toEqual({
      "listing-1:mockup-1": {
        assetId: "new",
        // The recorded fingerprint is the current one: that is the explicit
        // promise the user made by clicking "link".
        fingerprint: "fp-current",
        designId: "design-1",
        mockupId: "mockup-1",
        renderedAt: 300,
        source: "mockups",
      },
    });
  });

  it("links a render whose old fingerprint no longer matches", () => {
    const index = buildSavedRenderIndex([
      renderAsset({ id: "stale", createdAt: 50, renderFp: "fp-v2-of-something-else" }),
    ]);
    const entries = linkSavedRenderEntries(index, [target()]);
    expect(entries["listing-1:mockup-1"]?.assetId).toBe("stale");
  });

  it("never overwrites a covered tile and skips pairs with no saved render", () => {
    const index = buildSavedRenderIndex([renderAsset({ id: "saved", createdAt: 10 })]);
    const entries = linkSavedRenderEntries(index, [
      target({ covered: true }),
      target({ key: "listing-1:mockup-9", mockupId: "mockup-9" }),
    ]);
    expect(entries).toEqual({});
  });

  it("counts exactly what it would write", () => {
    const index = buildSavedRenderIndex([
      renderAsset({ id: "m1", createdAt: 10 }),
      renderAsset({ id: "m2", createdAt: 20, sourceMockupId: "mockup-2" }),
    ]);
    const entries = linkSavedRenderEntries(index, [
      target(),
      target({ key: "listing-1:mockup-2", mockupId: "mockup-2" }),
      target({ key: "listing-1:mockup-3", mockupId: "mockup-3" }),
      target({ key: "listing-1:mockup-4", mockupId: "mockup-4", covered: true }),
    ]);
    expect(Object.keys(entries).sort()).toEqual([
      "listing-1:mockup-1",
      "listing-1:mockup-2",
    ]);
  });
});

describe("findLatestSavedRender", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("finds a render without a fingerprint and prefers the newest", async () => {
    await db.assets.bulkPut([
      renderAsset({ id: "old", createdAt: 100, renderFp: "fp-old" }),
      renderAsset({ id: "new", createdAt: 300, renderFp: undefined }),
      renderAsset({ id: "other-mockup", createdAt: 400, sourceMockupId: "mockup-2" }),
    ]);

    const found = await findLatestSavedRender({
      artworkAssetId: "design-asset",
      mockupId: "mockup-1",
    });
    expect(found?.id).toBe("new");
  });

  it("returns null when the pair has no saved render", async () => {
    await db.assets.put(renderAsset({ id: "only", parentId: "other-asset" }));
    expect(
      await findLatestSavedRender({
        artworkAssetId: "design-asset",
        mockupId: "mockup-1",
      }),
    ).toBeNull();
  });
});
