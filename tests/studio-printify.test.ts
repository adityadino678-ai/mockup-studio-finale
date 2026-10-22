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
import { MAX_UPSCALE, clampPlacement, computeFit } from "@/lib/printify/fit";
import { planDesignColours } from "@/lib/printify/design-colours";
import {
  buildCatalogueIndex,
  buildPartition,
  enabledVariantIds,
  resolveVariantIds,
} from "@/lib/printify/variants";
import {
  DEFAULT_PLACEMENT,
  assertCompletePartition,
  buildPrintAreas,
  describePartitionProblems,
} from "@/lib/printify/print-areas";
import type { CatalogVariant } from "@/lib/printify/types";

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

describe("placement fit", () => {
  it("reproduces Printify's rule of thumb for exact-width artwork", () => {
    // Artwork the width of the placeholder => scale 1, centred at 0.5/0.5.
    const fit = computeFit({
      artworkWidth: 2419,
      artworkHeight: 2761,
      areaWidth: 2419,
      areaHeight: 2761,
    });
    expect(fit.scale).toBeCloseTo(1);
    expect(fit.x).toBeCloseTo(0.5);
    expect(fit.y).toBeCloseTo(0.5);
  });

  it("centres artwork that is narrower than the area", () => {
    const fit = computeFit({
      artworkWidth: 1209.5,
      artworkHeight: 2761,
      areaWidth: 2419,
      areaHeight: 2761,
    });
    expect(fit.scale).toBeCloseTo(0.5);
    // Centred: the left offset plus half the scaled width.
    expect(fit.x).toBeCloseTo(0.5);
    expect(fit.y).toBeCloseTo(0.5);
  });

  it("converts edge offsets into Printify's centre convention", () => {
    // Wider than tall in a square area: the width fills it, the height does
    // not, so the artwork sits above the vertical centre.
    const fit = computeFit({
      artworkWidth: 1000,
      artworkHeight: 500,
      areaWidth: 2000,
      areaHeight: 2000,
    });
    expect(fit.width).toBeCloseTo(2000);
    expect(fit.height).toBeCloseTo(1000);
    // A quarter of the area is empty above the artwork.
    expect(fit.offsetY).toBeCloseTo(0.25);
    expect(fit.scale).toBeCloseTo(1);
    // ...which is why the centre is still 0.5: the offset and the half-size
    // of the artwork cancel out.
    expect(fit.y).toBeCloseTo(0.5);
    expect(fit.x).toBeCloseTo(0.5);
  });

  it("scales artwork up to fill the area when it is half the size", () => {
    // Exactly half the area: filled exactly, so scale 1 and centred.
    const fit = computeFit({
      artworkWidth: 1000,
      artworkHeight: 1000,
      areaWidth: 2000,
      areaHeight: 2000,
    });
    expect(fit.scale).toBeCloseTo(1);
    expect(fit.x).toBeCloseTo(0.5);
    expect(fit.y).toBeCloseTo(0.5);
  });

  it("limits how far small artwork is blown up", () => {
    // Tiny artwork may be scaled up, but never past the upscale cap.
    const fit = computeFit({
      artworkWidth: 100,
      artworkHeight: 100,
      areaWidth: 3000,
      areaHeight: 3000,
    });
    expect(fit.factor).toBeLessThanOrEqual(MAX_UPSCALE);
    expect(fit.width).toBeLessThanOrEqual(3000);
  });

  it("rejects zero-sized input", () => {
    expect(() =>
      computeFit({ artworkWidth: 0, artworkHeight: 10, areaWidth: 10, areaHeight: 10 }),
    ).toThrow(/positive dimensions/i);
  });

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

  it("covers every variant exactly once", () => {
    const partition = buildPartition(index, [
      { ink: "black", colors: ["Heather Grey"] },
      { ink: "white", colors: ["Solid Black"] },
    ]);
    expect(partition.complete).toBe(true);
    expect(partition.covered).toHaveLength(18);
    // The colours nobody named are absorbed by the last group, and reported
    // so the caller can see which ones were picked up implicitly.
    expect(partition.unclaimed).toHaveLength(6);
    expect(partition.groups[1].variantIds).toContain(17643);
    expect(partition.groups[0].variantIds).toHaveLength(6);
  });

  it("gives every variant to exactly one group", () => {
    const partition = buildPartition(index, [
      { ink: "black", colors: ["Heather Grey"] },
      { ink: "white", colors: ["Solid Black"] },
      { ink: "main", colors: ["Solid White"] },
    ]);
    const all = partition.groups.flatMap((g) => g.variantIds);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(18);
  });

  it("keeps each colour's variants with the group that claims it, in any order", () => {
    // The order of the groups does not change which group owns a colour.
    // (Which group absorbs the leftovers does depend on the order - that is
    // the group that has to come last by design.)
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

  it("accepts a complete partition", () => {
    const partition = buildPartition(index, [
      { ink: "black", colors: ["Heather Grey"] },
      { ink: "white", colors: ["Solid Black"] },
    ]);
    const problems = assertCompletePartition(
      partition.groups.map((g) => ({ imageId: "x", variantIds: g.variantIds, colors: g.colors })),
      index.allVariantIds,
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
