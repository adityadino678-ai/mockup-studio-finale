import { describe, expect, it } from "vitest";
import {
  buildStudioPlan,
  emptyPanelProblems,
  studioPartitionProblems,
  studioPlanProblems,
  undecidedInkProblems,
} from "@/lib/printify/studio-plan";
import { buildCatalogueIndex } from "@/lib/printify/variants";
import type { CatalogVariant } from "@/lib/printify/types";
import type { Design, StudioSession } from "@/types/domain";

// ---------------------------------------------------------------------------
// The two colour panels are INDEPENDENT.
//
// A design in the "No ink variants" row prints ONLY the plain panel's colours;
// a design in the "Has ink variants" row prints ONLY the ink panel's colours,
// split by the per-colour Black ink / White ink switch. Neither row reaches
// into the other panel - that was the bug that put every shirt on the
// black-ink design and left the white-ink design with one colour.
//
// The failure mode this rule creates is an EMPTY panel: a design whose own
// panel has no colours would create a product that prints on nothing. That is
// BLOCKED, with a message naming the design and the panel, so nothing is ever
// created half-right. Nothing is moved between panels automatically - that was
// deliberately removed, because silently rewriting the user's selection is
// worse than asking.
// ---------------------------------------------------------------------------

const SIZES = ["S", "M", "L"];
const PLAIN = ["Solid White", "Natural"];
const BLACK_INK = ["Solid Black", "Navy"];
const WHITE_INK = ["Red"];
const COLOURS = [...PLAIN, ...BLACK_INK, ...WHITE_INK];

const CATALOGUE: CatalogVariant[] = COLOURS.flatMap((colour, colourIndex) =>
  SIZES.map((size, sizeIndex) => ({
    id: 40000 + colourIndex * 10 + sizeIndex,
    title: `${colour} / ${size}`,
    options: { color: colour, size },
  })),
);

function design(id: string, extra: Partial<Design> = {}): Design {
  return {
    id,
    name: id,
    originalAssetId: `asset-${id}`,
    createdAt: 1,
    tags: [],
    ...extra,
  } as Design;
}

function session(patch: Partial<StudioSession> = {}): StudioSession {
  return {
    sizes: SIZES,
    rows: {
      plain: { colors: [...PLAIN], blackInkColors: [], whiteInkColors: [] },
      ink: { colors: [...BLACK_INK, ...WHITE_INK], blackInkColors: [...BLACK_INK], whiteInkColors: [...WHITE_INK] },
    },
    designIds: ["plain-design", "ink-design"],
    inkPairIds: ["ink-design"],
    inkPairs: [],
    universalPlacement: { position: "front", x: 0.5, y: 0.5, scale: 1, angle: 0 },
    placements: {},
    priceCents: 1999,
    blueprintId: 1,
    printProviderId: 1,
    ...patch,
  } as StudioSession;
}

const DESIGNS = [
  design("plain-design"),
  design("ink-design", { blackInkAssetId: "asset-black", whiteInkAssetId: "asset-white" }),
];

describe("buildStudioPlan - each design gets its own panel's colours", () => {
  it("gives a no-ink design the plain panel and an ink design the ink panel", () => {
    const plan = buildStudioPlan(DESIGNS, session(), CATALOGUE);
    expect(plan).not.toBeNull();

    const plainItem = plan!.items.find((item) => item.designId === "plain-design")!;
    const inkItem = plan!.items.find((item) => item.designId === "ink-design")!;

    // The no-ink design prints the plain panel only.
    expect(plainItem.groups.flatMap((g) => g.colors).sort()).toEqual([...PLAIN].sort());
    expect(plainItem.row).toBe("plain");

    // The ink design prints the ink panel only, split by the switch.
    expect(inkItem.groups.map((g) => ({ ink: g.ink, colors: g.colors }))).toEqual([
      { ink: "black", colors: BLACK_INK },
      { ink: "white", colors: WHITE_INK },
    ]);
    expect(inkItem.row).toBe("ink");

    // No colour leaks between the two.
    const plainColors = new Set(plainItem.groups.flatMap((g) => g.colors));
    for (const colour of inkItem.groups.flatMap((g) => g.colors)) {
      expect(plainColors.has(colour)).toBe(false);
    }
  });

  it("gives a pair's halves the ink panel, split by the switch, and never the plain panel", () => {
    const s = session({
      designIds: ["a", "b"],
      inkPairIds: ["a", "b"],
      inkPairs: [{ blackInkDesignId: "a", whiteInkDesignId: "b" }],
    });
    const plan = buildStudioPlan([design("a"), design("b")], s, CATALOGUE);

    expect(plan!.items).toHaveLength(1);
    const pair = plan!.items[0];
    expect(pair.memberIds).toEqual(["a", "b"]);
    expect(pair.groups.map((g) => g.colors)).toEqual([BLACK_INK, WHITE_INK]);
    for (const colour of PLAIN) {
      expect(pair.groups.flatMap((g) => g.colors)).not.toContain(colour);
    }
  });
});

describe("emptyPanelProblems - a design whose own panel is empty", () => {
  it("blocks a no-ink design when the plain panel is empty", () => {
    const s = session({
      rows: {
        plain: { colors: [], blackInkColors: [], whiteInkColors: [] },
        ink: { colors: [...BLACK_INK, ...WHITE_INK], blackInkColors: [...BLACK_INK], whiteInkColors: [...WHITE_INK] },
      },
    });
    const plan = buildStudioPlan(DESIGNS, s, CATALOGUE)!;
    const problems = emptyPanelProblems(plan);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"plain-design"');
    expect(problems[0]).toContain("No ink variants");
    expect(problems[0]).toContain("no colours are selected");
  });

  it("blocks an ink design when the ink panel is empty", () => {
    const s = session({
      rows: {
        plain: { colors: [...PLAIN], blackInkColors: [], whiteInkColors: [] },
        ink: { colors: [], blackInkColors: [], whiteInkColors: [] },
      },
    });
    const plan = buildStudioPlan(DESIGNS, s, CATALOGUE)!;
    const problems = emptyPanelProblems(plan);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"ink-design"');
    expect(problems[0]).toContain("Has ink variants");
  });

  it("blocks a pair when the ink panel is empty", () => {
    const s = session({
      designIds: ["a", "b"],
      inkPairIds: ["a", "b"],
      inkPairs: [{ blackInkDesignId: "a", whiteInkDesignId: "b" }],
      rows: {
        plain: { colors: [...PLAIN], blackInkColors: [], whiteInkColors: [] },
        ink: { colors: [], blackInkColors: [], whiteInkColors: [] },
      },
    });
    const plan = buildStudioPlan([design("a"), design("b")], s, CATALOGUE)!;
    const problems = emptyPanelProblems(plan);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"a"');
    expect(problems[0]).toContain("Has ink variants");
  });

  it("reports nothing when both panels have colours", () => {
    const plan = buildStudioPlan(DESIGNS, session(), CATALOGUE)!;
    expect(emptyPanelProblems(plan)).toEqual([]);
  });

  it("reaches studioPlanProblems, which is what the autopilot gates on", () => {
    const s = session({
      rows: {
        plain: { colors: [], blackInkColors: [], whiteInkColors: [] },
        ink: { colors: [...BLACK_INK, ...WHITE_INK], blackInkColors: [...BLACK_INK], whiteInkColors: [...WHITE_INK] },
      },
    });
    const plan = buildStudioPlan(DESIGNS, s, CATALOGUE)!;

    const problems = studioPlanProblems(plan, DESIGNS, s);
    expect(problems.some((p) => p.includes('"plain-design"') && p.includes("No ink variants"))).toBe(
      true,
    );
  });

  it("is reported for the Studio's Create gate too", () => {
    const s = session({
      rows: {
        plain: { colors: [...PLAIN], blackInkColors: [], whiteInkColors: [] },
        ink: { colors: [], blackInkColors: [], whiteInkColors: [] },
      },
    });
    const plan = buildStudioPlan(DESIGNS, s, CATALOGUE)!;

    const problems = studioPartitionProblems(plan, s);
    // The partition check alone only says "no variants match"; the empty-panel
    // problem is the one that names the design and the panel to fix.
    expect(emptyPanelProblems(plan).length).toBe(1);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("undecided ink colours block creation", () => {
  it("leaves an undecided colour out of both pair halves and leads studioPlanProblems", () => {
    const s = session({
      designIds: ["a", "b"],
      inkPairIds: ["a", "b"],
      inkPairs: [{ blackInkDesignId: "a", whiteInkDesignId: "b" }],
      rows: {
        plain: { colors: [...PLAIN], blackInkColors: [], whiteInkColors: [] },
        ink: {
          colors: [...BLACK_INK, ...WHITE_INK, "Mystery"],
          blackInkColors: [...BLACK_INK],
          whiteInkColors: [...WHITE_INK],
        },
      },
    });
    const plan = buildStudioPlan([design("a"), design("b")], s, CATALOGUE)!;
    const pair = plan.items[0];

    // "Mystery" is marked neither black nor white, so it prints on nothing.
    expect(pair.groups.flatMap((g) => g.colors)).not.toContain("Mystery");
    for (const colour of [...BLACK_INK, ...WHITE_INK]) {
      expect(pair.groups.flatMap((g) => g.colors)).toContain(colour);
    }

    // undecidedInkProblems reports it, and studioPlanProblems leads with it.
    const undecidedProblems = undecidedInkProblems(plan);
    expect(undecidedProblems.length).toBeGreaterThan(0);
    expect(undecidedProblems[0]).toContain("Mystery");
    expect(undecidedProblems[0]).toContain("no ink yet");

    const problems = studioPlanProblems(plan, [design("a"), design("b")], s);
    expect(problems[0]).toContain("Mystery");
    expect(problems[0]).toContain("no ink yet");
  });
});

describe("the colour index still completes the partition", () => {
  it("keeps every catalogue variant covered exactly once", () => {
    const index = buildCatalogueIndex(CATALOGUE);
    expect(index.allVariantIds).toHaveLength(COLOURS.length * SIZES.length);
    expect(new Set(index.allVariantIds).size).toBe(index.allVariantIds.length);
  });
});
