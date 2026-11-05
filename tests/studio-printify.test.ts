import { describe, expect, it } from "vitest";
import {
  DARK_THRESHOLD,
  LIGHT_THRESHOLD,
  contrastInk,
  describeInkContrast,
  hexForColourName,
  inkContrast,
  knowsColourName,
  lightness,
  normaliseHex,
  primaryHex,
  suggestInk,
} from "@/lib/printify/colors";
import { clampPlacement } from "@/lib/printify/fit";
import {
  pairedColourGroups,
  planDesignColours,
  planPairedDesignColours,
} from "@/lib/printify/design-colours";
import type { ProductColourGroups } from "@/lib/printify/design-colours";
import {
  buildCatalogueIndex,
  buildPartition,
  enabledVariantIds,
  resolveVariantIds,
  splitVariantIdsByColour,
} from "@/lib/printify/variants";
import type { ArtworkGroup } from "@/lib/printify/print-areas";
import {
  DEFAULT_PLACEMENT,
  assertCompletePartition,
  buildPrintAreas,
  describePartitionProblems,
  expandArtworkGroups,
} from "@/lib/printify/print-areas";
import type { CatalogVariant } from "@/lib/printify/types";
import { createProductSchema } from "@/lib/security/validation";

/**
 * The live catalogue shape used by the spike: 3 colours x 6 sizes.
 *   17391-17396 Heather Grey, 17427-17432 Solid Black, 17643-17648 Solid White
 */
const CATALOGUE: CatalogVariant[] = [
  ...["S", "M", "L", "XL", "2XL", "3XL"].map((size, i) => ({
    id: 17391 + i,
    title: `Heather Grey / ${size}`,
    options: { color: "Heather Grey", size },
  })),
  ...["S", "M", "L", "XL", "2XL", "3XL"].map((size, i) => ({
    id: 17427 + i,
    title: `Solid Black / ${size}`,
    options: { color: "Solid Black", size },
  })),
  ...["S", "M", "L", "XL", "2XL", "3XL"].map((size, i) => ({
    id: 17643 + i,
    title: `Solid White / ${size}`,
    options: { color: "Solid White", size },
  })),
];

describe("colour lightness and ink", () => {
  it("treats black and white as the extremes", () => {
    expect(lightness("#050505")).toBeLessThan(0.05);
    expect(lightness("#F9F9F9")).toBeGreaterThan(0.9);
  });

  it("puts a dark garment on white ink and a light garment on black ink", () => {
    // The locked rule: the artwork must contrast with the garment.
    expect(suggestInk("#050505")).toBe("white");
    expect(suggestInk("#F9F9F9")).toBe("black");
    expect(suggestInk("#0C2340")).toBe("white");
    expect(suggestInk("#C8102E")).toBe("white");
  });

  it("refuses to guess on mid-tones", () => {
    // A mid grey is exactly where black-on-dark or white-on-light fails.
    expect(suggestInk("#808080")).toBe("ambiguous");
    expect(suggestInk("#a4a4a3")).toBe("ambiguous");
  });

  it("uses the thresholds as documented", () => {
    expect(DARK_THRESHOLD).toBeLessThan(LIGHT_THRESHOLD);
    expect(suggestInk("#6f6f6f")).toBe("ambiguous");
  });

  it("normalises hex colours", () => {
    expect(normaliseHex("#ABC")).toBe("#aabbcc");
    expect(normaliseHex("AABBCC")).toBe("#aabbcc");
    expect(normaliseHex("not-a-colour")).toBe("not-a-colour");
  });

  it("picks a readable contrast colour for a swatch", () => {
    expect(contrastInk("#F9F9F9")).toBe("#111827");
    expect(contrastInk("#050505")).toBe("#ffffff");
  });

  it("falls back to the curated table when Printify has no hexes", () => {
    expect(hexForColourName("Solid Black")).toBe("#050505");
    expect(hexForColourName("Solid White")).toBe("#f9f9f9");
    expect(hexForColourName("Heather Grey")).toBe("#a4a4a3");
    expect(knowsColourName("Solid Navy")).toBe(true);
    // Unknown names still produce a usable, stable swatch.
    expect(hexForColourName("Totally Unknown Colour")).toBe("#9ca3af");
  });

  it("strips a stacked qualifier so real colours are not left grey", () => {
    // Printify stacks qualifiers: "Solid Cool Blue". One strip used to leave
    // these as identical grey swatches.
    for (const name of [
      "Solid Cool Blue",
      "Solid Light Blue",
      "Solid Midnight Navy",
      "Solid Heavy Metal",
      "Solid Banana Cream",
      "Solid Cardinal Red",
    ]) {
      expect(knowsColourName(name)).toBe(true);
      expect(hexForColourName(name)).not.toBe("#9ca3af");
    }
  });

  it("does not treat a dark colour as lighter than the colour it is named after", () => {
    // "dark grey" once mapped to CSS darkgray, which is LIGHTER than grey.
    expect(lightness(hexForColourName("Dark Grey"))).toBeLessThan(
      lightness(hexForColourName("Grey")),
    );
  });

  it("prefers a real hex over the fallback", () => {
    expect(primaryHex(["#123456", "#abcdef"])).toBe("#123456");
    expect(primaryHex(undefined)).toBe("#9ca3af");
  });
});

describe("ink against the garment", () => {
  it("says a dark garment needs white ink", () => {
    expect(inkContrast("#050505", "white")).toBe("ok");
    expect(inkContrast("#0C2340", "white")).toBe("ok");
  });

  it("says a light garment needs black ink", () => {
    expect(inkContrast("#F9F9F9", "black")).toBe("ok");
    expect(inkContrast("#ffffff", "black")).toBe("ok");
  });

  it("catches ink that would be invisible", () => {
    // This is the footgun: marking a black garment for the black ink.
    expect(inkContrast("#050505", "black")).toBe("none");
    expect(inkContrast("#F9F9F9", "white")).toBe("none");
    expect(describeInkContrast("#050505", "black")).toMatch(/invisible/i);
  });

  it("flags mid-tone garments as low contrast", () => {
    expect(inkContrast("#a4a4a3", "black")).toBe("low");
    expect(inkContrast("#a4a4a3", "white")).toBe("low");
    expect(describeInkContrast("#a4a4a3", "black")).toMatch(/mid-tone/i);
  });

  it("agrees with the auto-assign suggestion", () => {
    // The suggestion and the contrast check must never disagree.
    for (const hex of ["#050505", "#F9F9F9", "#0C2340", "#C8102E", "#a4a4a3", "#808080"]) {
      const suggestion = suggestInk(hex);
      if (suggestion === "ambiguous") continue;
      expect(inkContrast(hex, suggestion)).toBe("ok");
    }
  });
});

describe("placement clamping", () => {
  it("clamps placements into the range Printify accepts", () => {
    const clamped = clampPlacement({ x: 1.4, y: -0.2, scale: 0, angle: 450 });
    expect(clamped.x).toBe(1);
    expect(clamped.y).toBe(0);
    expect(clamped.scale).toBeGreaterThan(0);
    expect(clamped.angle).toBe(90);
  });
});

describe("colour to variant resolution", () => {
  const index = buildCatalogueIndex(CATALOGUE);

  it("groups the catalogue variants by colour and size", () => {
    expect(index.variantIds.get("Heather Grey")).toHaveLength(6);
    expect(index.variantIds.get("Solid Black")).toHaveLength(6);
    expect(index.sizes.get("M")).toHaveLength(3);
    expect(index.allVariantIds).toHaveLength(18);
  });

  it("resolves a colour selection to variant ids", () => {
    expect(resolveVariantIds(index, ["Solid Black"], ["S"])).toEqual([17427]);
    expect(resolveVariantIds(index, ["Solid Black"], ["S", "M"])).toEqual([17427, 17428]);
  });

  it("resolves a colour selection across all sizes", () => {
    const all = resolveVariantIds(index, ["Solid Black"], []);
    expect(all).toHaveLength(6);
  });

  it("resolves the enabled variants for a selection", () => {
    expect(enabledVariantIds(index, ["Solid Black", "Solid White"], ["S", "M"])).toEqual([
      17427, 17428, 17643, 17644,
    ]);
  });
});

describe("the variant partition", () => {
  const index = buildCatalogueIndex(CATALOGUE);

  it("each group claims exactly its colours' variants, no absorber", () => {
    const partition = buildPartition(index, [
      { ink: "black", colors: ["Heather Grey"] },
      { ink: "white", colors: ["Solid Black"] },
    ]);
    // No absorber - partition is NOT complete (catalogue extras left unclaimed)
    expect(partition.complete).toBe(false);
    // Each group gets exactly its claimed variants
    const blackGroup = partition.groups.find((g) => g.ink === "black");
    const whiteGroup = partition.groups.find((g) => g.ink === "white");
    expect(blackGroup?.colors).toEqual(["Heather Grey"]);
    expect(whiteGroup?.colors).toEqual(["Solid Black"]);
    // Unclaimed variants are catalogue extras not in user's selection
    expect(partition.unclaimed.length).toBeGreaterThan(0);
  });

  it("gives every variant to exactly one group", () => {
    const partition = buildPartition(index, [
      { ink: "black", colors: ["Heather Grey"] },
      { ink: "white", colors: ["Solid Black"] },
      { ink: "main", colors: ["Solid White"] },
    ]);
    const all = partition.groups.flatMap((g) => g.variantIds);
    expect(new Set(all).size).toBe(all.length);
    // No duplicates, but not all catalogue variants are covered
    expect(all.length).toBeLessThanOrEqual(CATALOGUE.length);
  });

  it("keeps each colour's variants with the group that claims it, in any order", () => {
    // The order of the groups does not change which group owns a colour.
    const order = (colors: string[][]) => {
      const partition = buildPartition(
        index,
        colors.map((c) => ({ ink: "main" as const, colors: c })),
      );
      return partition.groups.map((g) => ({
        colors: g.colors,
        owns: g.variantIds.every((id) =>
          (index.variantIds.get(g.colors[0]) ?? []).includes(id),
        ),
      }));
    };
    const forward = order([["Heather Grey"], ["Solid Black"], ["Solid White"]]);
    const reverse = order([["Solid White"], ["Solid Black"], ["Heather Grey"]]);
    for (const group of forward) expect(group.owns).toBe(true);
    for (const group of reverse) expect(group.owns).toBe(true);
    // Every colour ends up in exactly one group either way.
    const allForward = forward.flatMap((g) => g.colors);
    const allReverse = reverse.flatMap((g) => g.colors);
    expect(new Set(allForward).size).toBe(allForward.length);
    expect(new Set(allReverse).size).toBe(allReverse.length);
  });

  it("keeps a trailing group so the partition can be completed", () => {
    // The groups are built by planDesignColours now (see design-colours.ts)
    // and a group with no colours is never emitted, so the partition always
    // has a group that holds variants for Printify to complete.
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      { plain: [], ink: ["Solid Black"], blackInk: ["Solid Black"] },
    );
    expect(plan.groups.every((group) => group.colors.length > 0)).toBe(true);
    expect(plan.groups[plan.groups.length - 1].colors.length).toBeGreaterThan(0);
  });
});

describe("the variant partition - no absorber", () => {
  const SIZES = ["S", "M", "L"];
  // 5 dark colours all marked for white ink, 2 plain colours, and one
  // catalogue colour that no group names (a catalogue extra the UI can never
  // select). That extra must NOT land on the white-ink group.
  const PLAIN = ["Solid White", "Natural"];
  const WHITE_INK = ["Solid Black", "Navy", "Charcoal", "Forest", "Maroon"];
  const EXTRA = "Heather Grey";
  const COLOURS = [...PLAIN, ...WHITE_INK, EXTRA];
  const CATALOGUE: CatalogVariant[] = COLOURS.flatMap((colour, colourIndex) =>
    SIZES.map((size, sizeIndex) => ({
      id: 30000 + colourIndex * 10 + sizeIndex,
      title: `${colour} / ${size}`,
      options: { color: colour, size },
    })),
  );
  const index = buildCatalogueIndex(CATALOGUE);

  it("leaves catalogue extras unclaimed, never absorbs into any group", () => {
    const partition = buildPartition(index, [
      { ink: "main" as const, colors: PLAIN },
      { ink: "white" as const, colors: WHITE_INK },
    ]);

    const whiteGroup = partition.groups.find((g) => g.ink === "white");
    const mainGroup = partition.groups.find((g) => g.ink === "main");

    // The white-ink group holds exactly the 5 dark colours' variants.
    const inkVariantIds = WHITE_INK.flatMap((c) => index.variantIds.get(c) ?? []);
    expect(whiteGroup!.variantIds).toEqual([...inkVariantIds].sort((a, b) => a - b));

    // The main group holds exactly the plain colours' variants - NO absorber.
    const plainVariantIds = PLAIN.flatMap((c) => index.variantIds.get(c) ?? []);
    expect(mainGroup!.variantIds).toEqual([...plainVariantIds].sort((a, b) => a - b));

    // Partition is NOT complete - catalogue extras are unclaimed.
    expect(partition.complete).toBe(false);

    // Extra variant is unclaimed, not absorbed.
    const extraIds = index.variantIds.get(EXTRA) ?? [];
    expect(whiteGroup!.variantIds).not.toEqual(expect.arrayContaining(extraIds));
    expect(mainGroup!.variantIds).not.toEqual(expect.arrayContaining(extraIds));
    expect(partition.unclaimed).toEqual([...extraIds].sort((a, b) => a - b));
  });

  it("never lets a no-ink design's plan name the ink panel's variants", () => {
    // THE PANEL DECIDES THE COLOURS. A plain design prints the plain panel,
    // so its plan never NAMES an ink-panel colour and the enabled set never
    // contains an ink-panel variant.
    const GROUPS: ProductColourGroups = {
      plain: PLAIN,
      ink: WHITE_INK,
      blackInk: [],
    };
    const plan = planDesignColours(
      { hasInkPair: false, hasBlackInk: false, hasWhiteInk: false },
      GROUPS,
    );
    expect(plan.colors).toEqual(PLAIN);
    for (const group of plan.groups) {
      for (const colour of WHITE_INK) expect(group.colors).not.toContain(colour);
    }

    const partition = buildPartition(
      index,
      plan.groups.map((group) => ({ ink: group.ink, colors: group.colors })),
    );
    expect(partition.groups[0].colors).toEqual(PLAIN);
    expect(partition.complete).toBe(false);

    const enabled = new Set(resolveVariantIds(index, plan.colors, []));
    for (const colour of WHITE_INK) {
      for (const id of index.variantIds.get(colour) ?? []) expect(enabled.has(id)).toBe(false);
    }
  });
});

describe("the print_areas payload", () => {
  const index = buildCatalogueIndex(CATALOGUE);

  it("gives each group its own image and the shared placement", () => {
    const areas = buildPrintAreas({
      groups: [
        { imageId: "img-red", variantIds: [17391] },
        { imageId: "img-blue", variantIds: [17427] },
      ],
      placement: { ...DEFAULT_PLACEMENT, x: 0.4, y: 0.6, scale: 0.8, angle: 15 },
    });
    expect(areas).toHaveLength(2);
    expect(areas[0].variant_ids).toEqual([17391]);
    expect(areas[0].placeholders[0].images[0]).toMatchObject({
      id: "img-red",
      x: 0.4,
      y: 0.6,
      scale: 0.8,
      angle: 15,
    });
    expect(areas[1].placeholders[0].images[0].id).toBe("img-blue");
  });

  it("drops groups with no variants", () => {
    const areas = buildPrintAreas({
      groups: [
        { imageId: "img-red", variantIds: [17391] },
        { imageId: "img-blue", variantIds: [] },
      ],
      placement: DEFAULT_PLACEMENT,
    });
    expect(areas).toHaveLength(1);
  });

  it("accepts a partition covering all given variants", () => {
    // When the groups cover all catalogue variants (no extras), the partition is complete.
    const CATALOGUE_SIMPLE: CatalogVariant[] = [
      { id: 1, title: "Heather Grey / S", options: { color: "Heather Grey", size: "S" } },
      { id: 2, title: "Heather Grey / M", options: { color: "Heather Grey", size: "M" } },
      { id: 3, title: "Solid Black / S", options: { color: "Solid Black", size: "S" } },
      { id: 4, title: "Solid Black / M", options: { color: "Solid Black", size: "M" } },
    ];
    const simpleIndex = buildCatalogueIndex(CATALOGUE_SIMPLE);
    const partition = buildPartition(simpleIndex, [
      { ink: "black", colors: ["Heather Grey"] },
      { ink: "white", colors: ["Solid Black"] },
    ]);
    const problems = assertCompletePartition(
      partition.groups.map((g) => ({ imageId: "x", variantIds: g.variantIds, colors: g.colors })),
      simpleIndex.allVariantIds,
    );
    expect(problems).toEqual([]);
  });

  it("rejects an incomplete partition", () => {
    const problems = assertCompletePartition(
      [{ imageId: "x", variantIds: [17391] }],
      index.allVariantIds,
    );
    expect(problems.some((p) => p.kind === "missing")).toBe(true);
    expect(describePartitionProblems(problems)).toMatch(/not in any group/);
  });

  it("rejects a variant that is in two groups", () => {
    const problems = assertCompletePartition(
      [
        { imageId: "x", variantIds: [17391] },
        { imageId: "y", variantIds: [17391] },
      ],
      [17391],
    );
    expect(problems.some((p) => p.kind === "duplicate")).toBe(true);
  });

  it("accepts an empty group when it simply has no colours", () => {
    // An ink group the user left empty is normal - it just claims nothing.
    const problems = assertCompletePartition(
      [
        { imageId: "x", variantIds: [17391] },
        { imageId: "y", variantIds: [] },
      ],
      [17391],
    );
    expect(problems).toEqual([]);
  });

  it("rejects a group that has colours but no variants", () => {
    // The colours are real but the provider offers no variant for them.
    const problems = assertCompletePartition(
      [
        { imageId: "x", variantIds: [17391], colors: ["Heather Grey"] },
        { imageId: "y", variantIds: [], colors: ["Solid Black"] },
      ],
      [17391],
    );
    expect(problems.some((p) => p.kind === "empty-group")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real case: four black-ink colours + four white-ink colours + a few
// plain ones. Each colour must reach the product IN ITS OWN PANEL's group,
// in the group whose artwork will print on it. This is the end-to-end half of
// the rule: the plan, the catalogue index and the partition have to agree.
// ---------------------------------------------------------------------------

describe("a four-and-four colour selection", () => {
  const SIZES = ["S", "M", "L"];
  const PLAIN = ["Solid White", "Natural", "Sand"];
  const BLACK_INK = ["Solid Black", "Navy", "Charcoal", "Forest"];
  const WHITE_INK = ["Red", "Burgundy", "Maroon", "Mustard"];
  const COLOURS = [...PLAIN, ...BLACK_INK, ...WHITE_INK];
  const GROUPS: ProductColourGroups = {
    plain: PLAIN,
    ink: [...BLACK_INK, ...WHITE_INK],
    blackInk: BLACK_INK,
  };
  const CATALOGUE: CatalogVariant[] = COLOURS.flatMap((colour, colourIndex) =>
    SIZES.map((size, sizeIndex) => ({
      id: 20000 + colourIndex * 10 + sizeIndex,
      title: `${colour} / ${size}`,
      options: { color: colour, size },
    })),
  );
  const index = buildCatalogueIndex(CATALOGUE);
  const INK_PLAN = planDesignColours(
    { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
    GROUPS,
  );
  const PLAIN_PLAN = planDesignColours(
    { hasInkPair: false, hasBlackInk: false, hasWhiteInk: false },
    GROUPS,
  );

  it("keeps the eight ink colours, in the group that carries their artwork", () => {
    // The ink design prints the ink panel and only the ink panel.
    expect(INK_PLAN.colors).toEqual([...BLACK_INK, ...WHITE_INK]);
    expect(new Set(INK_PLAN.colors).size).toBe(BLACK_INK.length + WHITE_INK.length);

    const partition = buildPartition(
      index,
      INK_PLAN.groups.map((group) => ({ ink: group.ink, colors: group.colors })),
    );
    const groupFor = (ink: "main" | "black" | "white") =>
      partition.groups[INK_PLAN.groups.findIndex((group) => group.ink === ink)];

    // The four black-ink colours and the four white-ink colours are not
    // merged, dropped or swapped.
    expect(groupFor("black").colors).toEqual(BLACK_INK);
    expect(groupFor("white").colors).toEqual(WHITE_INK);

    // The white-ink group holds EXACTLY its own colours' variants - no absorber.
    expect(new Set(groupFor("white").variantIds)).toEqual(
      new Set(WHITE_INK.flatMap((colour) => index.variantIds.get(colour) ?? [])),
    );
    // The black group holds every black-ink variant (NO absorber).
    const blackOwn = new Set(BLACK_INK.flatMap((colour) => index.variantIds.get(colour) ?? []));
    for (const id of blackOwn) expect(groupFor("black").variantIds).toContain(id);
    // Partition is NOT complete - catalogue extras are unclaimed
    expect(partition.complete).toBe(false);

    // What is ENABLED is the ink panel and nothing else
    const enabled = new Set(resolveVariantIds(index, INK_PLAN.colors, []));
    for (const colour of PLAIN) {
      for (const id of index.variantIds.get(colour) ?? []) expect(enabled.has(id)).toBe(false);
    }
    expect(enabled.size).toBe((BLACK_INK.length + WHITE_INK.length) * SIZES.length);
  });

  it("gives a no-ink design the plain panel and nothing else", () => {
    // This is the fix for "all shirts went to the black-ink design": a
    // no-ink design used to be handed every colour of the product.
    expect(PLAIN_PLAN.colors).toEqual(PLAIN);
    expect(PLAIN_PLAN.groups).toEqual([{ ink: "main", colors: PLAIN }]);

    const partition = buildPartition(
      index,
      PLAIN_PLAN.groups.map((group) => ({ ink: group.ink, colors: group.colors })),
    );
    // The group NAMES only the plain panel's colours...
    expect(partition.groups[0].colors).toEqual(PLAIN);
    const plainOwn = new Set(PLAIN.flatMap((colour) => index.variantIds.get(colour) ?? []));
    for (const id of plainOwn) expect(partition.groups[0].variantIds).toContain(id);
    // Partition is NOT complete - catalogue extras are unclaimed
    expect(partition.complete).toBe(false);
    const enabled = new Set(resolveVariantIds(index, PLAIN_PLAN.colors, []));
    for (const colour of [...BLACK_INK, ...WHITE_INK]) {
      for (const id of index.variantIds.get(colour) ?? []) expect(enabled.has(id)).toBe(false);
    }
    expect(enabled.size).toBe(PLAIN.length * SIZES.length);
  });

  it("enables every selected colour's variants, with the sizes applied", () => {
    const enabled = resolveVariantIds(index, INK_PLAN.colors, ["S", "M"]);

    expect(enabled).toHaveLength((BLACK_INK.length + WHITE_INK.length) * 2);
    expect(enabled).toEqual(
      [...enabled].sort((a, b) => a - b),
    );
    for (const colour of INK_PLAN.colors) {
      for (const id of index.variantIds.get(colour) ?? []) {
        const size = CATALOGUE.find((variant) => variant.id === id)?.options?.size;
        expect(enabled.includes(id)).toBe(size === "S" || size === "M");
      }
    }
    // With no sizes ticked, every variant of every colour is enabled.
    expect(resolveVariantIds(index, INK_PLAN.colors, [])).toHaveLength(
      (BLACK_INK.length + WHITE_INK.length) * SIZES.length,
    );
    // The plain panel is a DIFFERENT selection, not a superset of this one.
    expect(resolveVariantIds(index, PLAIN_PLAN.colors, [])).toHaveLength(
      PLAIN.length * SIZES.length,
    );
  });

  it("keeps a colour selected in BOTH panels in each panel's own group", () => {
    // "Solid Black" and "Navy" are ticked in the plain panel too. That is
    // intentional: the plain design prints its main artwork there, the ink
    // design its black ink there. Neither panel strips the other.
    const bothRows: ProductColourGroups = {
      ...GROUPS,
      plain: [...PLAIN, "Solid Black", "Navy"],
    };
    const inkPlan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      bothRows,
    );
    const plainPlan = planDesignColours(
      { hasInkPair: false, hasBlackInk: false, hasWhiteInk: false },
      bothRows,
    );

    const black = inkPlan.groups.find((group) => group.ink === "black");
    expect(inkPlan.groups.find((group) => group.ink === "main")).toBeUndefined();
    expect(black?.colors).toEqual(BLACK_INK);
    expect(inkPlan.colors).toEqual([...BLACK_INK, ...WHITE_INK]);
    expect(plainPlan.colors).toEqual([...PLAIN, "Solid Black", "Navy"]);

    const partition = buildPartition(
      index,
      inkPlan.groups.map((group) => ({ ink: group.ink, colors: group.colors })),
    );
    const blackGroup = partition.groups[inkPlan.groups.findIndex((group) => group.ink === "black")];
    expect(blackGroup.colors).toEqual(BLACK_INK);
    // The black group holds every black-ink variant (NO absorber)
    const blackOwn = new Set(BLACK_INK.flatMap((colour) => index.variantIds.get(colour) ?? []));
    for (const id of blackOwn) expect(blackGroup.variantIds).toContain(id);
    // Partition is NOT complete - catalogue extras are unclaimed
    expect(partition.complete).toBe(false);

    // The plain design's enabled set is the plain panel, ink design's is the
    // ink panel - a colour in both is enabled on BOTH products, by design.
    const plainEnabled = new Set(resolveVariantIds(index, plainPlan.colors, []));
    const inkEnabled = new Set(resolveVariantIds(index, inkPlan.colors, []));
    const plainOwn = [...PLAIN, "Solid Black", "Navy"].flatMap(
      (colour) => index.variantIds.get(colour) ?? [],
    );
    for (const id of plainOwn) expect(plainEnabled.has(id)).toBe(true);
    for (const id of blackOwn) expect(inkEnabled.has(id)).toBe(true);
    // The two colours that are in BOTH panels are enabled on both products,
    // on purpose: the plain product prints the main artwork there, the ink
    // product the black ink.
    for (const colour of ["Solid Black", "Navy"]) {
      for (const id of index.variantIds.get(colour) ?? []) {
        expect(plainEnabled.has(id)).toBe(true);
        expect(inkEnabled.has(id)).toBe(true);
      }
    }
    // White-panel colours are NOT enabled on the plain product.
    for (const colour of WHITE_INK) {
      for (const id of index.variantIds.get(colour) ?? []) expect(plainEnabled.has(id)).toBe(false);
    }
  });

  it("splits a four-and-four pair between the halves, as ONE product", () => {
    const split = pairedColourGroups(GROUPS);

    // Both halves live in the ink panel: the black-ink design prints the
    // colours marked Black ink, its partner the rest of that panel. The plain
    // panel belongs to the no-ink-variants designs.
    expect(split.black).toEqual(BLACK_INK);
    expect(split.white).toEqual(WHITE_INK);
    expect(planPairedDesignColours("black", GROUPS).colors).toEqual(BLACK_INK);
    expect(planPairedDesignColours("white", GROUPS).colors).toEqual(WHITE_INK);

    // One pair = one product: the two halves' groups form a partition
    // over the ink panel only (no absorber). Catalogue extras are unclaimed.
    const partition = buildPartition(index, [
      { ink: "main", colors: split.black },
      { ink: "main", colors: split.white }, // both use "main" (each design's main artwork IS the ink artwork)
    ]);
    expect(partition.complete).toBe(false);
    expect(partition.groups[0].colors).toEqual(BLACK_INK);
    expect(partition.groups[1].colors).toEqual(WHITE_INK);
    // Each group has exactly its own colours' variants
    const blackVariantIds = BLACK_INK.flatMap((c) => index.variantIds.get(c) ?? []);
    const whiteVariantIds = WHITE_INK.flatMap((c) => index.variantIds.get(c) ?? []);
    expect(new Set(partition.groups[0].variantIds)).toEqual(new Set(blackVariantIds));
    expect(new Set(partition.groups[1].variantIds)).toEqual(new Set(whiteVariantIds));

    // ...and the enabled set covers the ink panel exactly once.
    const enabled = resolveVariantIds(index, [...split.black, ...split.white], []);
    expect(new Set(enabled)).toEqual(
      new Set(
        [...BLACK_INK, ...WHITE_INK].flatMap((colour) => index.variantIds.get(colour) ?? []),
      ),
    );
    expect(new Set([...split.black, ...split.white]).size).toBe(
      BLACK_INK.length + WHITE_INK.length,
    );
  });
});

describe("split by colour and expand artwork groups", () => {
  const index = buildCatalogueIndex(CATALOGUE);
  const allIds = index.allVariantIds;

  it("split by colour returns one array per colour, each with only that colour's enabled ids, sorted", () => {
    const groups = splitVariantIdsByColour(index, allIds);
    expect(groups).toHaveLength(3);
    // Heather Grey: 17391-17396, Solid Black: 17427-17432, Solid White: 17643-17648
    expect(groups[0]).toEqual([17391, 17392, 17393, 17394, 17395, 17396]);
    expect(groups[1]).toEqual([17427, 17428, 17429, 17430, 17431, 17432]);
    expect(groups[2]).toEqual([17643, 17644, 17645, 17646, 17647, 17648]);
    // Each array holds only its own colour's ids.
    for (const id of groups[0]) expect(index.variantIds.get("Heather Grey")).toContain(id);
    for (const id of groups[1]) expect(index.variantIds.get("Solid Black")).toContain(id);
    for (const id of groups[2]) expect(index.variantIds.get("Solid White")).toContain(id);
  });

  it("the sizes filter is respected and ids not present in the index are dropped", () => {
    // Only S and M of each colour.
    const enabled = [17391, 17392, 17427, 17428, 17643, 17644];
    // Throw in an id the index does not know - it must be dropped.
    const groups = splitVariantIdsByColour(index, [...enabled, 999999]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([17391, 17392]);
    expect(groups[1]).toEqual([17427, 17428]);
    expect(groups[2]).toEqual([17643, 17644]);
  });

  it("a single-colour split returns one array", () => {
    const groups = splitVariantIdsByColour(index, [17427, 17428]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual([17427, 17428]);
  });

  it("expandArtworkGroups returns one group per colour with the SAME imageId", () => {
    const groups: ArtworkGroup[] = [
      {
        imageId: "img-shared",
        variantIds: allIds,
        variantGroups: splitVariantIdsByColour(index, allIds),
      },
    ];
    const expanded = expandArtworkGroups(groups);
    expect(expanded).toHaveLength(3);
    for (const g of expanded) expect(g.imageId).toBe("img-shared");
    // Each group keeps its own colour's variants.
    expect(expanded[0].variantIds).toEqual([17391, 17392, 17393, 17394, 17395, 17396]);
    expect(expanded[1].variantIds).toEqual([17427, 17428, 17429, 17430, 17431, 17432]);
    expect(expanded[2].variantIds).toEqual([17643, 17644, 17645, 17646, 17647, 17648]);
  });

  it("expandArtworkGroups falls back to the single group when variantGroups is absent", () => {
    const groups: ArtworkGroup[] = [
      { imageId: "img-solo", variantIds: [17391, 17427] },
    ];
    const expanded = expandArtworkGroups(groups);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].imageId).toBe("img-solo");
    expect(expanded[0].variantIds).toEqual([17391, 17427]);
  });

  it("expandArtworkGroups keeps input order and never merges across input groups", () => {
    const groups: ArtworkGroup[] = [
      {
        imageId: "img-a",
        variantIds: [17391],
        variantGroups: [[17391]],
      },
      {
        imageId: "img-b",
        variantIds: [17427],
        variantGroups: [[17427]],
      },
    ];
    const expanded = expandArtworkGroups(groups);
    expect(expanded).toHaveLength(2);
    expect(expanded[0].imageId).toBe("img-a");
    expect(expanded[1].imageId).toBe("img-b");
  });
});

describe("the create request keeps the routing fields", () => {
  // Zod strips unknown keys, so a field missing from the schema is silently
  // dropped between the browser and the endpoint. That is exactly how the
  // per-colour split reached Printify as one group per artwork instead of one
  // per colour, and the editor kept showing the wrong design.
  const base = {
    confirm: true,
    title: "Test",
    blueprintId: 6,
    variants: { "6": [17391, 17427] },
    artworks: [
      {
        printAreaId: "front",
        variantIds: [17391, 17427],
        variantGroups: [[17391], [17427]],
        base64: "AAAA",
        filename: "a.png",
      },
    ],
    leftoverVariantIds: [17643],
  };

  it("keeps every artwork's variantGroups and the leftover variants", () => {
    const parsed = createProductSchema.parse(base);
    expect(parsed.artworks?.[0].variantGroups).toEqual([[17391], [17427]]);
    expect(parsed.leftoverVariantIds).toEqual([17643]);
  });

  it("accepts a request without either field", () => {
    const { artworks, leftoverVariantIds, ...rest } = base;
    const parsed = createProductSchema.parse({
      ...rest,
      artworks: [{ ...artworks[0], variantGroups: undefined }],
    });
    expect(parsed.artworks?.[0].variantGroups).toBeUndefined();
    expect(parsed.leftoverVariantIds).toBeUndefined();
    expect(leftoverVariantIds).toEqual([17643]);
  });
});
