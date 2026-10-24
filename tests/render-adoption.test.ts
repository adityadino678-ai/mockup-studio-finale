import { describe, expect, it } from "vitest";
import {
  adoptedRenderEntry,
  buildAdoptionIndex,
  matchInAdoptionIndex,
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
    });
  });
});
