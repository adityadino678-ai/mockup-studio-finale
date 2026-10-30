import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db/schema";
import { emptySession } from "@/lib/printify/studio-session";
import {
  approveAutopilotListing,
  markAutopilotMockupsApplied,
  publishAutopilotRun,
  retryAutopilotPublish,
  retryAutopilotResearch,
  startAutopilotBuild,
  updateAutopilotCopy,
} from "@/lib/autopilot/runner";
import {
  AUTOPILOT_TAG_LENGTH,
  AUTOPILOT_TAG_LIMIT,
  autopilotStartProblems,
  fallbackCopy,
  mergeAiCopy,
  normaliseTags,
  suggestedPrice,
  withCurrentRenderState,
} from "@/lib/autopilot/plan";
import type { StudioPlan } from "@/lib/printify/studio-plan";
import type { AutopilotCopy, AutopilotListing, AutopilotRun } from "@/types/autopilot";
import type { StudioSession } from "@/types/domain";
import type { EtsyResearch } from "@/types/etsy";

// ---------------------------------------------------------------------------
// The autopilot's copy rules and its human gates.
//
// The runner is intentionally hard to move forward without a person:
//   * editing copy clears the approval;
//   * every listing must be approved before a build;
//   * publishing needs the bookmarklet confirmation AND a publish approval.
//
// These tests exercise the persisted state machine directly. They mock no
// network: every call below stops at a gate before any Printify request.
// ---------------------------------------------------------------------------

const research: EtsyResearch = {
  query: "cat shirt",
  searchedAt: 1,
  source: "etsy-api",
  activeListings: 120,
  sampled: 2,
  topTags: [{ term: "cat shirt", count: 2 }],
  titleTerms: [{ term: "cat", count: 2 }],
  samples: [],
  disclaimer: "Observed active listings only.",
};

const copy: AutopilotCopy = {
  title: "Personalized Cat Shirt",
  description: "A custom cat shirt.",
  tags: ["cat shirt", "cat mom"],
  priceCents: 2499,
  quantity: 1,
  groundedOnEtsy: true,
  disclaimer: research.disclaimer,
};

function listing(overrides: Partial<AutopilotListing> = {}): AutopilotListing {
  return {
    id: "design-1",
    designId: "design-1",
    memberIds: ["design-1"],
    designName: "Cat",
    status: "drafted",
    copy,
    updatedAt: 1,
    ...overrides,
  };
}

function run(overrides: Partial<AutopilotRun> = {}): AutopilotRun {
  return {
    id: "run-1",
    createdAt: 1,
    updatedAt: 1,
    status: "needs-review",
    stage: "copy-review",
    query: "cat shirt",
    niche: "cat lovers",
    productName: "T-Shirt",
    blueprintId: 6,
    printProviderId: 30,
    shopId: 123,
    priceCents: 2499,
    listings: [listing()],
    research,
    session: emptySession(),
    log: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await db.autopilotRuns.clear();
});

describe("normaliseTags", () => {
  it("dedupes case-insensitively, strips a leading #, and caps length", () => {
    const tags = normaliseTags([
      "#Cat Shirt",
      "cat shirt",
      "  cat   mom  ",
      "this tag is definitely longer than twenty characters",
      "",
      42,
    ]);
    expect(tags[0]).toBe("Cat Shirt");
    expect(tags[1]).toBe("cat mom");
    expect(tags[2]).toHaveLength(AUTOPILOT_TAG_LENGTH);
    expect(tags).toHaveLength(3);
  });

  it("never returns more than Etsy's 13 tags", () => {
    const tags = normaliseTags(Array.from({ length: 40 }, (_, index) => `tag ${index}`));
    expect(tags).toHaveLength(AUTOPILOT_TAG_LIMIT);
  });
});

describe("withCurrentRenderState", () => {
  it("takes the latest placement and renders but keeps the run's image selection", () => {
    const snapshot = {
      ...emptySession(),
      listingImages: { "design-1": ["mockup-a", "mockup-b"] },
      placements: {
        "design-1": { position: "front" as const, x: 0.1, y: 0.1, scale: 1, angle: 0 },
      },
      listingRenders: {
        "design-1:mockup-a": {
          assetId: "asset-old",
          fingerprint: "old",
          designId: "design-1",
          mockupId: "mockup-a",
          renderedAt: 1,
        },
      },
    };
    const current = {
      ...emptySession(),
      listingImages: { "design-1": ["mockup-b"] },
      universalPlacement: {
        position: "front" as const,
        x: 0.6,
        y: 0.4,
        scale: 1.1,
        angle: 10,
      },
      placements: {
        "design-1": { position: "front" as const, x: 0.8, y: 0.7, scale: 1.2, angle: 15 },
      },
      listingRenders: {
        "design-1:mockup-b": {
          assetId: "asset-new",
          fingerprint: "new",
          designId: "design-1",
          mockupId: "mockup-b",
          renderedAt: 2,
        },
      },
    };

    const merged = withCurrentRenderState(snapshot, current);
    expect(merged.listingImages).toEqual({ "design-1": ["mockup-a", "mockup-b"] });
    expect(merged.placements).toEqual(current.placements);
    expect(merged.universalPlacement).toEqual(current.universalPlacement);
    expect(merged.listingRenders).toEqual(current.listingRenders);
  });

  it("derives the old implicit white for a run snapshotted before whiteInkColors", () => {
    const snapshot = {
      ...emptySession(),
      rows: {
        plain: { colors: ["White"], blackInkColors: [], whiteInkColors: [] },
        ink: { colors: ["Black", "Navy", "Sand"], blackInkColors: ["Black"] },
      },
    } as unknown as StudioSession;

    const merged = withCurrentRenderState(snapshot, emptySession());
    // Same reading the run had when it started: black stays black, the rest
    // was white. Nothing is left undecided, so the run is not blocked.
    expect(merged.rows.ink?.whiteInkColors).toEqual(["Navy", "Sand"]);
    expect(merged.rows.ink?.blackInkColors).toEqual(["Black"]);
  });

  it("keeps an explicit empty white list - those colours stay undecided", () => {
    const snapshot = {
      ...emptySession(),
      rows: {
        plain: { colors: [], blackInkColors: [], whiteInkColors: [] },
        ink: { colors: ["Black", "Navy"], blackInkColors: ["Black"], whiteInkColors: [] },
      },
    };

    const merged = withCurrentRenderState(snapshot, emptySession());
    expect(merged.rows.ink?.whiteInkColors).toEqual([]);
  });
});

describe("fallbackCopy", () => {
  it("uses the Studio templates and adds the observed Etsy terms", () => {
    const session = {
      ...emptySession(),
      titleTemplate: "{design} — {product}",
      descriptionTemplate: "A {product} for {design}.",
      tags: ["cat shirt"],
    };
    const result = fallbackCopy(listing(), session, "T-Shirt", 2499, research);
    expect(result.title).toBe("Cat — T-Shirt");
    expect(result.description).toBe("A T-Shirt for Cat.");
    expect(result.tags).toContain("cat shirt");
    expect(result.tags).toContain("cat");
    expect(result.priceCents).toBe(2499);
    expect(result.groundedOnEtsy).toBe(true);
    expect(result.disclaimer).toBe(research.disclaimer);
  });
});

describe("mergeAiCopy", () => {
  it("takes the AI title/description but keeps the explicit price", () => {
    const base = fallbackCopy(listing(), emptySession(), "T-Shirt", 2499, research);
    const merged = mergeAiCopy(
      base,
      {
        titleDrafts: ["  Handmade Cat Shirt for Cat Lovers  ", "ignored"],
        description: "A longer description.",
        tags: ["cat lover gift"],
        disclaimer: "AI disclaimer",
      },
      research,
    );
    expect(merged.title).toBe("Handmade Cat Shirt for Cat Lovers");
    expect(merged.description).toBe("A longer description.");
    expect(merged.priceCents).toBe(2499);
    expect(merged.tags[0]).toBe("cat lover gift");
    expect(merged.tags.length).toBeLessThanOrEqual(AUTOPILOT_TAG_LIMIT);
    expect(merged.disclaimer).toBe("AI disclaimer");
    expect(merged.groundedOnEtsy).toBe(true);
  });

  it("falls back to the template copy when the AI returns nothing usable", () => {
    const base = fallbackCopy(listing(), emptySession(), "T-Shirt", 2499, research);
    const merged = mergeAiCopy(base, { title: "   ", description: "" }, research);
    expect(merged.title).toBe(base.title);
    expect(merged.description).toBe(base.description);
    expect(merged.tags).toEqual(base.tags);
  });

  it("caps an over-long AI title and description", () => {
    const base = fallbackCopy(listing(), emptySession(), "T-Shirt", 2499, research);
    const merged = mergeAiCopy(
      base,
      { title: "x".repeat(200), description: "y".repeat(6000) },
      research,
    );
    expect(merged.title).toHaveLength(140);
    expect(merged.description).toHaveLength(5000);
  });
});

describe("autopilotStartProblems", () => {
  it("names every missing prerequisite", () => {
    const problems = autopilotStartProblems({
      designs: [],
      session: emptySession(),
      plan: null,
      planProblems: ["The plan has an incomplete colour group."],
      priceCents: 0,
      hasEtsyKey: false,
      shopId: undefined,
    });
    expect(problems.join(" ")).toContain("developer keystring");
    expect(problems.join(" ")).toContain("Printify shop");
    expect(problems.join(" ")).toContain("choose a product");
    expect(problems.join(" ")).toContain("Tick at least one design");
    expect(problems.join(" ")).toContain("at least 1.00");
    expect(problems.join(" ")).toContain("incomplete colour group");
  });

  it("returns no problems for a deliberate, complete run", () => {
    const session = { ...emptySession(), designIds: ["design-1"] };
    const plan = { items: [] } as unknown as StudioPlan;
    expect(
      autopilotStartProblems({
        designs: [],
        session,
        plan,
        planProblems: [],
        priceCents: 2499,
        hasEtsyKey: true,
        shopId: 123,
      }),
    ).toEqual([]);
  });
});

describe("suggestedPrice", () => {
  it("uses the session's fixed price or its custom override", () => {
    expect(suggestedPrice(emptySession(), "design-1")).toBe(1999);
    expect(
      suggestedPrice(
        {
          ...emptySession(),
          priceMode: "custom",
          listingPrices: { "design-1": 3199 },
        },
        "design-1",
      ),
    ).toBe(3199);
  });
});

describe("runner human gates", () => {
  it("editing copy clears the approval and enforces Etsy's tag limits", async () => {
    await db.autopilotRuns.put(
      run({ listings: [listing({ reviewApprovedAt: Date.now() })] }),
    );

    await updateAutopilotCopy("run-1", "design-1", {
      title: "A new title",
      tags: Array.from({ length: 20 }, (_, index) => `tag ${index} with a tail`),
      priceCents: 3199,
    });

    const after = await db.autopilotRuns.get("run-1");
    const edited = after?.listings[0];
    expect(edited?.reviewApprovedAt).toBeUndefined();
    expect(edited?.copy?.title).toBe("A new title");
    expect(edited?.copy?.tags).toHaveLength(AUTOPILOT_TAG_LIMIT);
    expect(edited?.copy?.tags.every((tag) => tag.length <= AUTOPILOT_TAG_LENGTH)).toBe(true);
    expect(edited?.copy?.priceCents).toBe(3199);
  });

  it("approves a listing, then refuses to build while another is unapproved", async () => {
    await db.autopilotRuns.put(
      run({
        listings: [
          listing({ id: "design-1" }),
          listing({ id: "design-2", designId: "design-2", designName: "Dog" }),
        ],
      }),
    );
    await approveAutopilotListing("run-1", "design-1");
    await expect(startAutopilotBuild("run-1")).rejects.toThrow(/Approve every listing first/);
  });

  it("refuses to build after the copy review is closed", async () => {
    await db.autopilotRuns.put(
      run({
        stage: "mockup-review",
        listings: [listing({ reviewApprovedAt: Date.now() })],
      }),
    );
    await expect(startAutopilotBuild("run-1")).rejects.toThrow(/already closed/);
  });

  it("moves mockup confirmation to the final publish gate, not to publishing", async () => {
    await db.autopilotRuns.put(run({ stage: "mockup-review", status: "needs-review" }));
    await markAutopilotMockupsApplied("run-1");
    const after = await db.autopilotRuns.get("run-1");
    expect(after?.stage).toBe("publish-review");
    expect(after?.mockupsAppliedAt).toBeTypeOf("number");
    expect(after?.publishApprovedAt).toBeUndefined();
  });

  it("requires the bookmarklet confirmation before a publish approval", async () => {
    await db.autopilotRuns.put(run({ stage: "publish-review", status: "needs-review" }));
    await expect(publishAutopilotRun("run-1")).rejects.toThrow(/Apply the mockups first/);
  });

  it("refuses to retry a publish that was never approved", async () => {
    await db.autopilotRuns.put(run({ stage: "publishing", status: "failed" }));
    await expect(retryAutopilotPublish("run-1")).rejects.toThrow(/never approved/);
  });

  it("refuses to retry research once a Printify product exists", async () => {
    await db.autopilotRuns.put(
      run({
        stage: "build",
        status: "failed",
        listings: [listing({ status: "created", productId: "product-1", shopId: 123 })],
      }),
    );
    await expect(retryAutopilotResearch("run-1")).rejects.toThrow(/products already exist/);
  });
});
