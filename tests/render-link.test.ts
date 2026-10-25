import { describe, expect, it } from "vitest";
import { linkSavedRender } from "@/lib/printify/render-link";
import { emptySession } from "@/lib/printify/studio-session";
import type { Design, StudioSession } from "@/types/domain";

/**
 * `linkSavedRender` is what makes "Save render" mean "save AND use": it finds
 * the listing that owns the pixels, records the render under that listing's
 * current fingerprint, and makes sure the mockup is part of the selection. A
 * pair is owned by its black-ink half, so the white half refuses rather than
 * attaching the wrong artwork.
 */

function design(id: string, name = id): Design {
  return {
    id,
    name,
    originalAssetId: `asset-${id}`,
    processedAssetId: undefined,
    createdAt: 1000,
  } as unknown as Design;
}

const baseDesigns: Design[] = [design("black", "Black"), design("white", "White"), design("solo")];

function session(overrides: Partial<StudioSession> = {}): StudioSession {
  return { ...emptySession(), designIds: ["black", "white", "solo"], ...overrides };
}

describe("linkSavedRender", () => {
  it("writes the render under the OWNING listing and marks it from Mockups", () => {
    const active = session();
    const result = linkSavedRender({
      designId: "black",
      mockupId: "mockup-1",
      assetId: "render-1",
      fingerprint: "fp-1",
      session: active,
      designs: baseDesigns,
    });
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.listing.designId).toBe("black");
    const entry = result.patch.listingRenders?.["black:mockup-1"];
    expect(entry).toMatchObject({
      assetId: "render-1",
      fingerprint: "fp-1",
      designId: "black",
      mockupId: "mockup-1",
      source: "mockups",
    });
  });

  it("blocks saving on a pair's white-ink half with an explanation", () => {
    const active = session({
      inkPairs: [{ blackInkDesignId: "black", whiteInkDesignId: "white" }],
    });
    const result = linkSavedRender({
      designId: "white",
      mockupId: "mockup-1",
      assetId: "render-1",
      fingerprint: "fp-1",
      session: active,
      designs: baseDesigns,
    });
    expect(result.status).toBe("white-half");
    if (result.status !== "white-half") return;
    // The pair listing is the black half, whose artwork is the real image.
    expect(result.listing.designId).toBe("black");
  });

  it("refuses a design that is not in the batch instead of guessing", () => {
    const active = { ...emptySession(), designIds: ["black"] };
    const result = linkSavedRender({
      designId: "solo",
      mockupId: "mockup-1",
      assetId: "render-1",
      fingerprint: "fp-1",
      session: active,
      designs: baseDesigns,
    });
    expect(result.status).toBe("not-in-batch");
  });

  it("extends an explicit selection, keeping order and dropping the cleared flag", () => {
    const active = session({
      listingImages: { black: ["mockup-a", "mockup-b"] },
      listingImageCleared: { black: true },
    });
    const result = linkSavedRender({
      designId: "black",
      mockupId: "mockup-b",
      assetId: "render-1",
      fingerprint: "fp-1",
      session: active,
      designs: baseDesigns,
    });
    if (result.status !== "linked") throw new Error("expected linked");
    // mockup-b was already in the list, so it is not duplicated.
    expect(result.patch.listingImages?.black).toEqual(["mockup-a", "mockup-b"]);
    expect(result.patch.listingImageCleared?.black).toBeUndefined();
  });

  it("adds a new mockup to an explicit selection", () => {
    const active = session({ listingImages: { black: ["mockup-a"] } });
    const result = linkSavedRender({
      designId: "black",
      mockupId: "mockup-z",
      assetId: "render-1",
      fingerprint: "fp-1",
      session: active,
      designs: baseDesigns,
    });
    if (result.status !== "linked") throw new Error("expected linked");
    expect(result.patch.listingImages?.black).toEqual(["mockup-a", "mockup-z"]);
  });

  it("revives a cleared selection with just the saved mockup", () => {
    const active = session({ listingImageCleared: { black: true } });
    const result = linkSavedRender({
      designId: "black",
      mockupId: "mockup-1",
      assetId: "render-1",
      fingerprint: "fp-1",
      session: active,
      designs: baseDesigns,
    });
    if (result.status !== "linked") throw new Error("expected linked");
    expect(result.patch.listingImages?.black).toEqual(["mockup-1"]);
    expect(result.patch.listingImageCleared?.black).toBeUndefined();
  });

  it("leaves a never-configured listing on the default 'every mockup' selection", () => {
    const active = session();
    const result = linkSavedRender({
      designId: "black",
      mockupId: "mockup-1",
      assetId: "render-1",
      fingerprint: "fp-1",
      session: active,
      designs: baseDesigns,
    });
    if (result.status !== "linked") throw new Error("expected linked");
    // No explicit list is written: the default already includes every mockup,
    // so writing one would silently pin a changing library.
    expect(result.patch.listingImages).toBeUndefined();
    expect(result.patch.listingRenders?.["black:mockup-1"]).toBeDefined();
  });

  it("preserves other listings' renders when writing one entry", () => {
    const active = session({
      listingRenders: {
        "solo:mockup-1": {
          assetId: "render-solo",
          fingerprint: "fp-solo",
          designId: "solo",
          mockupId: "mockup-1",
          renderedAt: 5,
        },
      },
    });
    const result = linkSavedRender({
      designId: "black",
      mockupId: "mockup-1",
      assetId: "render-1",
      fingerprint: "fp-1",
      session: active,
      designs: baseDesigns,
    });
    if (result.status !== "linked") throw new Error("expected linked");
    expect(result.patch.listingRenders?.["solo:mockup-1"]).toMatchObject({
      assetId: "render-solo",
    });
    expect(result.patch.listingRenders?.["black:mockup-1"]).toMatchObject({
      assetId: "render-1",
    });
  });
});
