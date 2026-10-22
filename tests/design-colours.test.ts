import { describe, expect, it } from "vitest";
import {
  coloursToMoveToPlain,
  inkArtworkProblems,
  normaliseColourGroups,
  planDesignColours,
  splitDesignsByProduct,
} from "@/lib/printify/design-colours";
import type { ProductColourGroups, SeparableDesign } from "@/lib/printify/design-colours";

// ---------------------------------------------------------------------------
// Separating the designs for ONE product.
//
// The separation is a property of the PAIR (product, design), not of the
// design alone: the same design can be a "no ink variants" design for one
// product and an "ink variants" design for another. So the tests below are
// all built around ONE product and the designs that go with it.
//
// The rule that matters most:
//
//   A design WITHOUT ink artwork prints its MAIN artwork on every colour of
//   the product. It used to print on nothing at all, because the ink colours
//   were waiting for an ink artwork the design did not have.
//
//   A design WITH ink artwork prints the ink artwork on the ink colours and
//   its main artwork on the plain ones.
//
// Why "every colour exactly once" is pinned so hard: Printify REWRITES an
// incomplete partition and then prints the WRONG artwork on the variants it
// silently appended, so a design that covers a colour twice - or not at all -
// is a real production bug, not a cosmetic one.
// ---------------------------------------------------------------------------

/** A product with a plain group, a black-ink group and a white-ink group. */
const PRODUCT: ProductColourGroups = {
  plain: ["White", "Natural"],
  ink: ["Black", "Navy", "Red"],
  blackInk: ["Black", "Navy"],
};

/** Every colour of the product, in the order the plan reports them. */
const PRODUCT_COLOURS = ["White", "Natural", "Black", "Navy", "Red"];

/** A product whose ink colours are ALL white-ink. */
const WHITE_INK_ONLY: ProductColourGroups = {
  plain: ["White"],
  ink: ["Red"],
  blackInk: [],
};

/** A product whose ink colours are ALL black-ink. */
const BLACK_INK_ONLY: ProductColourGroups = {
  plain: ["White"],
  ink: ["Black"],
  blackInk: ["Black"],
};

/** A design with no ink artwork at all. */
const NO_INK: SeparableDesign = { id: "d-plain", name: "Plain Design" };

/** A design with both ink artworks. */
const BOTH_INKS: SeparableDesign = {
  id: "d-both",
  name: "Both Inks",
  blackInkAssetId: "asset-black",
  whiteInkAssetId: "asset-white",
};

/** A design with only the black ink artwork. */
const BLACK_ONLY: SeparableDesign = {
  id: "d-black",
  name: "Black Ink Only",
  blackInkAssetId: "asset-black",
};

/** A design with only the white ink artwork. */
const WHITE_ONLY: SeparableDesign = {
  id: "d-white",
  name: "White Ink Only",
  whiteInkAssetId: "asset-white",
};

/** True when the colour appears in `colors` more than once. */
function hasDuplicates(colors: string[]): boolean {
  return new Set(colors).size !== colors.length;
}

describe("normaliseColourGroups", () => {
  it("keeps a colour that is in both groups in the plain group only", () => {
    // "B" was put in both groups. It can only be printed once, and the plain
    // group wins - the plain group is printed with the design's main file,
    // which every design has.
    const normalised = normaliseColourGroups({
      plain: ["A", "B"],
      ink: ["B", "C"],
      blackInk: ["C"],
    });

    expect(normalised.plain).toEqual(["A", "B"]);
    expect(normalised.ink).toEqual(["C"]);
    expect(normalised.black).toEqual(["C"]);
    expect(normalised.white).toEqual([]);
  });

  it("ignores a black-ink colour that the product does not print with the ink artwork", () => {
    // "Z" is not in the ink group, so the product never prints it with an
    // ink. Marking it for the black ink must not invent an ink colour.
    const normalised = normaliseColourGroups({
      plain: [],
      ink: ["C"],
      blackInk: ["C", "Z"],
    });

    expect(normalised.black).toEqual(["C"]);
    expect(normalised.white).toEqual([]);
    expect(normalised.ink).not.toContain("Z");
  });

  it("removes the duplicates and keeps the order", () => {
    const normalised = normaliseColourGroups({
      plain: ["A", "A", "B"],
      ink: ["C", "D", "C"],
      blackInk: ["D"],
    });

    expect(normalised.plain).toEqual(["A", "B"]);
    expect(normalised.ink).toEqual(["C", "D"]);
    // The split follows the INK order, not the order of blackInk.
    expect(normalised.black).toEqual(["D"]);
    expect(normalised.white).toEqual(["C"]);
  });

  it("splits the ink colours into the black ink and the white ink", () => {
    const normalised = normaliseColourGroups(PRODUCT);

    expect(normalised.black).toEqual(["Black", "Navy"]);
    expect(normalised.white).toEqual(["Red"]);
    // The two halves together are exactly the ink group: no colour is lost
    // and none is used twice.
    expect([...normalised.black, ...normalised.white].sort()).toEqual(
      [...normalised.ink].sort(),
    );
  });
});

describe("planDesignColours - a design with no ink artwork", () => {
  it("prints the main artwork on EVERY colour of the product", () => {
    // This is the fix for "the design would print on nothing": the design
    // has no ink artwork, so the ink colours cannot use one. They print the
    // MAIN artwork instead.
    const plan = planDesignColours({ hasBlackInk: false, hasWhiteInk: false }, PRODUCT);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].ink).toBe("main");
    expect(plan.groups[0].colors).toEqual(PRODUCT_COLOURS);
    expect(plan.colors).toEqual(PRODUCT_COLOURS);
  });

  it("is a no-ink-variants design for that product", () => {
    const plan = planDesignColours({ hasBlackInk: false, hasWhiteInk: false }, PRODUCT);

    expect(plan.usesInkArtwork).toBe(false);
  });

  it("reports the ink colours it cannot serve", () => {
    // The ink colours are still reported, because the artwork is usually
    // invisible on them - the user has to know, not have it hidden.
    const plan = planDesignColours({ hasBlackInk: false, hasWhiteInk: false }, PRODUCT);

    expect(plan.missing).toEqual([
      { ink: "black", colors: ["Black", "Navy"] },
      { ink: "white", colors: ["Red"] },
    ]);
  });
});

describe("planDesignColours - a design with both ink artworks", () => {
  it("gets one group per ink", () => {
    const plan = planDesignColours({ hasBlackInk: true, hasWhiteInk: true }, PRODUCT);

    expect(plan.groups).toEqual([
      { ink: "main", colors: ["White", "Natural"] },
      { ink: "black", colors: ["Black", "Navy"] },
      { ink: "white", colors: ["Red"] },
    ]);
    expect(plan.usesInkArtwork).toBe(true);
    expect(plan.missing).toEqual([]);
  });

  it("covers every colour of the product exactly once", () => {
    // Printify silently completes an incomplete partition and then prints
    // the WRONG artwork, so an overlap or a gap here is a real bug.
    const plan = planDesignColours({ hasBlackInk: true, hasWhiteInk: true }, PRODUCT);
    const all = plan.groups.flatMap((group) => group.colors);

    expect([...all].sort()).toEqual([...PRODUCT_COLOURS].sort());
    expect(hasDuplicates(all)).toBe(false);
    expect(plan.colors).toEqual(PRODUCT_COLOURS);
  });
});

describe("planDesignColours - the ink label travels with the group", () => {
  it("never emits an empty group", () => {
    // This rule came from a bug that shipped: with the black group empty,
    // the white group shifted into position 0 and the artwork was chosen by
    // INDEX, so the white-ink colours were printed with the black-ink file.
    // A group with no colours is never emitted, so there is nothing to
    // shift.
    const plan = planDesignColours(
      { hasBlackInk: true, hasWhiteInk: true },
      { plain: [], ink: ["Solid Black", "Solid White"], blackInk: [] },
    );

    expect(plan.groups.every((group) => group.colors.length > 0)).toBe(true);
    // The colours are in the WHITE group, not in a group that merely
    // happens to come first.
    const white = plan.groups.find((group) => group.ink === "white");
    expect(white?.colors).toEqual(["Solid Black", "Solid White"]);
    expect(plan.groups.find((group) => group.ink === "black")).toBeUndefined();
  });

  it("names the group after the ink, not after its position", () => {
    const plan = planDesignColours(
      { hasBlackInk: true, hasWhiteInk: true },
      { plain: ["Natural"], ink: ["Black", "Red"], blackInk: ["Black"] },
    );

    expect(plan.groups.map((group) => group.ink)).toEqual(["main", "black", "white"]);
    expect(plan.groups.find((group) => group.ink === "black")?.colors).toEqual(["Black"]);
    expect(plan.groups.find((group) => group.ink === "white")?.colors).toEqual(["Red"]);
  });
});

describe("planDesignColours - ink artwork the product does not need", () => {
  it("treats a black-ink-only design as a no-ink-variants design on a white-ink product", () => {
    // The product prints "Red" with the WHITE ink. The design only has a
    // black-ink artwork, so there is no artwork the product can use.
    const plan = planDesignColours(
      { hasBlackInk: true, hasWhiteInk: false },
      WHITE_INK_ONLY,
    );

    expect(plan.usesInkArtwork).toBe(false);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toEqual({ ink: "main", colors: ["White", "Red"] });
    // And the white-ink colours it cannot serve are reported.
    expect(plan.missing).toEqual([{ ink: "white", colors: ["Red"] }]);
  });

  it("treats a white-ink-only design as a no-ink-variants design on a black-ink product", () => {
    const plan = planDesignColours(
      { hasBlackInk: false, hasWhiteInk: true },
      BLACK_INK_ONLY,
    );

    expect(plan.usesInkArtwork).toBe(false);
    expect(plan.groups).toEqual([{ ink: "main", colors: ["White", "Black"] }]);
    expect(plan.missing).toEqual([{ ink: "black", colors: ["Black"] }]);
  });

  it("uses no ink artwork for ANY design when the product's ink group is empty", () => {
    // The product never uses an ink, so the ink artwork of a design is
    // irrelevant here - even a design that HAS both ink artworks is a
    // "no ink variants" design for this product.
    const emptyInk: ProductColourGroups = { plain: ["White"], ink: [], blackInk: [] };

    for (const artwork of [
      { hasBlackInk: true, hasWhiteInk: true },
      { hasBlackInk: true, hasWhiteInk: false },
      { hasBlackInk: false, hasWhiteInk: true },
      { hasBlackInk: false, hasWhiteInk: false },
    ]) {
      const plan = planDesignColours(artwork, emptyInk);

      expect(plan.usesInkArtwork).toBe(false);
      expect(plan.groups).toEqual([{ ink: "main", colors: ["White"] }]);
      expect(plan.missing).toEqual([]);
      expect(plan.colors).toEqual(["White"]);
    }
  });
});

describe("planDesignColours - every design covers the product", () => {
  it("covers every colour of the product exactly once, whatever the design has", () => {
    const designs = [NO_INK, BOTH_INKS, BLACK_ONLY, WHITE_ONLY];

    for (const design of designs) {
      const plan = planDesignColours(
        {
          hasBlackInk: Boolean(design.blackInkAssetId),
          hasWhiteInk: Boolean(design.whiteInkAssetId),
        },
        PRODUCT,
      );
      const all = plan.groups.flatMap((group) => group.colors);

      expect([...all].sort()).toEqual([...PRODUCT_COLOURS].sort());
      expect(hasDuplicates(all)).toBe(false);
    }
  });
});

describe("splitDesignsByProduct", () => {
  const designs = [NO_INK, BOTH_INKS, BLACK_ONLY, WHITE_ONLY];

  it("matches the plan for every design", () => {
    // The buckets and the plan must never disagree: a design in the "ink"
    // bucket always contributes an ink artwork to THIS product, and one in
    // the "plain" bucket never does.
    const split = splitDesignsByProduct(designs, PRODUCT);

    for (const design of split.ink) {
      const plan = planDesignColours(
        {
          hasBlackInk: Boolean(design.blackInkAssetId),
          hasWhiteInk: Boolean(design.whiteInkAssetId),
        },
        PRODUCT,
      );
      expect(plan.usesInkArtwork).toBe(true);
    }
    for (const design of split.plain) {
      const plan = planDesignColours(
        {
          hasBlackInk: Boolean(design.blackInkAssetId),
          hasWhiteInk: Boolean(design.whiteInkAssetId),
        },
        PRODUCT,
      );
      expect(plan.usesInkArtwork).toBe(false);
    }
  });

  it("puts the designs with usable ink artwork in the ink bucket", () => {
    const split = splitDesignsByProduct(designs, PRODUCT);

    expect(split.ink.map((d) => d.id)).toEqual(["d-both", "d-black", "d-white"]);
    expect(split.plain.map((d) => d.id)).toEqual(["d-plain"]);
  });

  it("keeps the order of the designs inside the buckets", () => {
    const split = splitDesignsByProduct(designs, PRODUCT);

    expect(split.ink.map((d) => d.id)).toEqual(
      designs.filter((d) => d.id !== "d-plain").map((d) => d.id),
    );
  });

  it("puts EVERY design in the plain bucket for a product with an empty ink group", () => {
    const split = splitDesignsByProduct(designs, { plain: ["White"], ink: [], blackInk: [] });

    expect(split.ink).toEqual([]);
    expect(split.plain.map((d) => d.id)).toEqual(["d-plain", "d-both", "d-black", "d-white"]);
  });

  it("puts EVERY design in the plain bucket for a product that needs an ink the designs lack", () => {
    // The product prints "Red" with the white ink and neither of these
    // designs has a white-ink artwork, so neither contributes an ink
    // artwork to this product.
    const split = splitDesignsByProduct([NO_INK, BLACK_ONLY], WHITE_INK_ONLY);

    expect(split.ink).toEqual([]);
    expect(split.plain.map((d) => d.id)).toEqual(["d-plain", "d-black"]);
  });
});

describe("inkArtworkProblems", () => {
  it("names the design, the missing ink and the exact colours", () => {
    // This is the check that says "this design would be invisible on those
    // garments" in plain words, instead of letting the partition fail with
    // "132 variants are not in any group".
    const problems = inkArtworkProblems([NO_INK], PRODUCT);

    expect(problems).toEqual([
      { designId: "d-plain", designName: "Plain Design", ink: "black", colors: ["Black", "Navy"] },
      { designId: "d-plain", designName: "Plain Design", ink: "white", colors: ["Red"] },
    ]);
  });

  it("has no problem for a design with both ink artworks", () => {
    expect(inkArtworkProblems([BOTH_INKS], PRODUCT)).toEqual([]);
  });

  it("reports only the ink the design is actually missing", () => {
    const problems = inkArtworkProblems([BLACK_ONLY, WHITE_ONLY], PRODUCT);

    expect(problems).toEqual([
      { designId: "d-black", designName: "Black Ink Only", ink: "white", colors: ["Red"] },
      { designId: "d-white", designName: "White Ink Only", ink: "black", colors: ["Black", "Navy"] },
    ]);
  });

  it("reports nothing when the product has no ink colours", () => {
    expect(
      inkArtworkProblems([NO_INK, BOTH_INKS, BLACK_ONLY, WHITE_ONLY], {
        plain: ["White"],
        ink: [],
        blackInk: [],
      }),
    ).toEqual([]);
  });
});

describe("coloursToMoveToPlain", () => {
  it("returns every colour that has to move, without duplicates", () => {
    // The one-click fix: moving these colours into the plain group makes
    // every design able to print them, with the main artwork.
    const problems = inkArtworkProblems([NO_INK, BLACK_ONLY], PRODUCT);
    const moved = coloursToMoveToPlain(problems);

    expect([...moved].sort()).toEqual(["Black", "Navy", "Red"]);
    expect(hasDuplicates(moved)).toBe(false);
  });

  it("returns nothing when there is no problem", () => {
    expect(coloursToMoveToPlain(inkArtworkProblems([BOTH_INKS], PRODUCT))).toEqual([]);
  });
});

describe("degenerate input", () => {
  it("plans nothing for a product with no colours", () => {
    const plan = planDesignColours(
      { hasBlackInk: true, hasWhiteInk: true },
      { plain: [], ink: [], blackInk: [] },
    );

    expect(plan.groups).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.colors).toEqual([]);
    expect(plan.usesInkArtwork).toBe(false);
  });

  it("treats a design with undefined asset ids as a no-ink-variants design", () => {
    const split = splitDesignsByProduct([{ id: "d", name: "No assets" }], PRODUCT);

    expect(split.plain.map((d) => d.id)).toEqual(["d"]);
    expect(split.ink).toEqual([]);
  });

  it("treats an empty asset id as no ink artwork", () => {
    // An empty string is not an artwork: the file was never uploaded.
    const split = splitDesignsByProduct(
      [{ id: "d", name: "Empty", blackInkAssetId: "", whiteInkAssetId: "" }],
      PRODUCT,
    );

    expect(split.plain.map((d) => d.id)).toEqual(["d"]);
  });

  it("splits an empty list into two empty buckets", () => {
    const split = splitDesignsByProduct([], PRODUCT);

    expect(split.plain).toEqual([]);
    expect(split.ink).toEqual([]);
  });

  it("reports no problem for an empty list of designs", () => {
    expect(inkArtworkProblems([], PRODUCT)).toEqual([]);
  });
});
