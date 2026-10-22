import { describe, expect, it } from "vitest";
import {
  inkArtworkProblems,
  normaliseColourGroups,
  pairedColourGroups,
  pairedDesignIds,
  pairForDesign,
  planDesignColours,
  planPairedDesignColours,
  setInkPairRole,
  splitDesignsByInkPair,
  withInkPair,
  withoutInkPair,
} from "@/lib/printify/design-colours";
import type { ProductColourGroups, SeparableDesign } from "@/lib/printify/design-colours";

// ---------------------------------------------------------------------------
// Printing the designs on ONE product.
//
// WHICH design uses the ink artwork is the USER'S decision: the Designs tab
// gives every design an "Ink variants" checkbox, and the ticks are stored in
// `session.inkPairIds`. Nothing here infers a pairing from the artwork on
// file or from the product - the tests below pin that the tick is the only
// thing that decides.
//
// The rules that matter most:
//
//   A design the user did NOT pair prints its MAIN artwork on every colour of
//   the product, and is never reported as "missing ink" - that is a choice,
//   not a defect.
//
//   A design the user DID pair prints the ink artwork on the ink colours and
//   its main artwork on the plain ones, and is reported when its ink artwork
//   cannot cover them.
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

describe("planDesignColours - a design the user did NOT pair", () => {
  it("prints the main artwork on EVERY colour of the product", () => {
    // This is the fix for "the design would print on nothing": the design is
    // not paired, so it cannot use an ink artwork on the ink colours. They
    // print the MAIN artwork instead.
    const plan = planDesignColours(
      { hasInkPair: false, hasBlackInk: false, hasWhiteInk: false },
      PRODUCT,
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].ink).toBe("main");
    expect(plan.groups[0].colors).toEqual(PRODUCT_COLOURS);
    expect(plan.colors).toEqual(PRODUCT_COLOURS);
  });

  it("never uses ink artwork, and never reports a missing ink", () => {
    // Unticked is a CHOICE: the design prints one artwork everywhere, so
    // there is nothing wrong to report.
    const plan = planDesignColours(
      { hasInkPair: false, hasBlackInk: false, hasWhiteInk: false },
      PRODUCT,
    );

    expect(plan.usesInkArtwork).toBe(false);
    expect(plan.missing).toEqual([]);
  });

  it("ignores ink artwork that is on file but not ticked", () => {
    // The whole point of the manual split: having the files must not decide
    // anything. Only the tick does.
    const plan = planDesignColours(
      { hasInkPair: false, hasBlackInk: true, hasWhiteInk: true },
      PRODUCT,
    );

    expect(plan.groups).toEqual([{ ink: "main", colors: PRODUCT_COLOURS }]);
    expect(plan.usesInkArtwork).toBe(false);
    expect(plan.missing).toEqual([]);
  });
});

describe("planDesignColours - a design the user PAIRED", () => {
  it("gets one group per ink", () => {
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      PRODUCT,
    );

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
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      PRODUCT,
    );
    const all = plan.groups.flatMap((group) => group.colors);

    expect([...all].sort()).toEqual([...PRODUCT_COLOURS].sort());
    expect(hasDuplicates(all)).toBe(false);
    expect(plan.colors).toEqual(PRODUCT_COLOURS);
  });

  it("prints the main artwork on the ink colours it has no artwork for, and says so", () => {
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: false },
      PRODUCT,
    );

    expect(plan.groups).toEqual([
      { ink: "main", colors: ["White", "Natural", "Red"] },
      { ink: "black", colors: ["Black", "Navy"] },
    ]);
    expect(plan.missing).toEqual([{ ink: "white", colors: ["Red"] }]);
  });

  it("uses no ink artwork when the product's ink group is empty", () => {
    const emptyInk: ProductColourGroups = { plain: ["White"], ink: [], blackInk: [] };
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      emptyInk,
    );

    expect(plan.usesInkArtwork).toBe(false);
    expect(plan.groups).toEqual([{ ink: "main", colors: ["White"] }]);
    expect(plan.missing).toEqual([]);
  });

  it("does not report a missing ink the product never needs", () => {
    // The design only has a black-ink file and the product only prints with
    // the white ink: nothing is missing that the product could use.
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: false },
      WHITE_INK_ONLY,
    );

    expect(plan.groups).toEqual([{ ink: "main", colors: ["White", "Red"] }]);
    expect(plan.missing).toEqual([{ ink: "white", colors: ["Red"] }]);
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
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
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
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      { plain: ["Natural"], ink: ["Black", "Red"], blackInk: ["Black"] },
    );

    expect(plan.groups.map((group) => group.ink)).toEqual(["main", "black", "white"]);
    expect(plan.groups.find((group) => group.ink === "black")?.colors).toEqual(["Black"]);
    expect(plan.groups.find((group) => group.ink === "white")?.colors).toEqual(["Red"]);
  });
});

describe("planDesignColours - every design covers the product", () => {
  it("covers every colour of the product exactly once, whatever the design has", () => {
    const designs = [NO_INK, BOTH_INKS, BLACK_ONLY, WHITE_ONLY];
    const paired = new Set(["d-both", "d-white"]);

    for (const design of designs) {
      const plan = planDesignColours(
        {
          hasInkPair: paired.has(design.id),
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

describe("splitDesignsByInkPair", () => {
  const designs = [NO_INK, BOTH_INKS, BLACK_ONLY, WHITE_ONLY];

  it("puts exactly the ticked designs in the ink row", () => {
    const split = splitDesignsByInkPair(designs, ["d-both", "d-white"]);

    expect(split.ink.map((d) => d.id)).toEqual(["d-both", "d-white"]);
    expect(split.plain.map((d) => d.id)).toEqual(["d-plain", "d-black"]);
  });

  it("ignores the ink artwork on file - only the tick counts", () => {
    // BOTH_INKS has both ink files and is NOT ticked, and NO_INK has none
    // but IS ticked. The split must follow the ticks, not the files.
    const split = splitDesignsByInkPair([BOTH_INKS, NO_INK], ["d-plain"]);

    expect(split.ink.map((d) => d.id)).toEqual(["d-plain"]);
    expect(split.plain.map((d) => d.id)).toEqual(["d-both"]);
  });

  it("keeps the order of the designs inside the buckets", () => {
    const split = splitDesignsByInkPair(designs, ["d-white", "d-both"]);

    expect(split.ink.map((d) => d.id)).toEqual(["d-both", "d-white"]);
  });

  it("puts every design in the plain row when nothing is ticked", () => {
    const split = splitDesignsByInkPair(designs, []);

    expect(split.ink).toEqual([]);
    expect(split.plain.map((d) => d.id)).toEqual(["d-plain", "d-both", "d-black", "d-white"]);
  });

  it("ignores an id that no longer belongs to a design", () => {
    const split = splitDesignsByInkPair([NO_INK], ["d-deleted"]);

    expect(split.ink).toEqual([]);
    expect(split.plain.map((d) => d.id)).toEqual(["d-plain"]);
  });

  it("splits an empty list into two empty buckets", () => {
    const split = splitDesignsByInkPair([], ["d-plain"]);

    expect(split.plain).toEqual([]);
    expect(split.ink).toEqual([]);
  });
});

describe("inkArtworkProblems", () => {
  it("names the design, the missing ink and the exact colours", () => {
    // This is the check that says "this design would be invisible on those
    // garments" in plain words, instead of letting the partition fail with
    // "132 variants are not in any group".
    const problems = inkArtworkProblems([NO_INK], PRODUCT, ["d-plain"]);

    expect(problems).toEqual([
      { designId: "d-plain", designName: "Plain Design", ink: "black", colors: ["Black", "Navy"] },
      { designId: "d-plain", designName: "Plain Design", ink: "white", colors: ["Red"] },
    ]);
  });

  it("reports nothing for an UNPAIRED design, even with no ink artwork", () => {
    // The user left the box unticked, so printing one artwork everywhere is
    // exactly what they asked for. Reporting it would be nagging about a
    // decision the user already made.
    expect(inkArtworkProblems([NO_INK], PRODUCT, [])).toEqual([]);
  });

  it("has no problem for a paired design with both ink artworks", () => {
    expect(inkArtworkProblems([BOTH_INKS], PRODUCT, ["d-both"])).toEqual([]);
  });

  it("reports only the ink the design is actually missing", () => {
    const problems = inkArtworkProblems([BLACK_ONLY, WHITE_ONLY], PRODUCT, [
      "d-black",
      "d-white",
    ]);

    expect(problems).toEqual([
      { designId: "d-black", designName: "Black Ink Only", ink: "white", colors: ["Red"] },
      { designId: "d-white", designName: "White Ink Only", ink: "black", colors: ["Black", "Navy"] },
    ]);
  });

  it("reports only the paired designs in a mixed batch", () => {
    const problems = inkArtworkProblems([NO_INK, BOTH_INKS, WHITE_ONLY], PRODUCT, ["d-both"]);

    expect(problems).toEqual([]);
  });

  it("reports nothing when the product has no ink colours", () => {
    expect(
      inkArtworkProblems([NO_INK, BOTH_INKS, BLACK_ONLY, WHITE_ONLY], {
        plain: ["White"],
        ink: [],
        blackInk: [],
      }, ["d-plain", "d-black"]),
    ).toEqual([]);
  });

  it("reports no problem for an empty list of designs", () => {
    expect(inkArtworkProblems([], PRODUCT, ["d-plain"])).toEqual([]);
  });
});

describe("degenerate input", () => {
  it("plans nothing for a product with no colours", () => {
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      { plain: [], ink: [], blackInk: [] },
    );

    expect(plan.groups).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.colors).toEqual([]);
    expect(plan.usesInkArtwork).toBe(false);
  });

  it("plans one empty main group for an unpaired design on an empty product", () => {
    const plan = planDesignColours(
      { hasInkPair: false, hasBlackInk: true, hasWhiteInk: true },
      { plain: [], ink: [], blackInk: [] },
    );

    expect(plan.groups).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.colors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pairing two UPLOADED designs
//
// Two designs can print as ONE listing: one carries the black-ink artwork, the
// other the white-ink artwork. The black-ink design covers the plain AND the
// black-ink colours (black ink reads on a light garment), its partner the
// remaining ink colours. Together they cover every colour exactly once.
// ---------------------------------------------------------------------------

describe("pairedColourGroups", () => {
  it("gives the plain and black-ink colours to the black half", () => {
    expect(pairedColourGroups(PRODUCT)).toEqual({
      black: ["White", "Natural", "Black", "Navy"],
      white: ["Red"],
    });
  });

  it("never puts a colour in both halves", () => {
    const split = pairedColourGroups(PRODUCT);
    expect(hasDuplicates([...split.black, ...split.white])).toBe(false);
    expect([...split.black, ...split.white].sort()).toEqual([...PRODUCT_COLOURS].sort());
  });

  it("has no white half when every ink colour uses black ink", () => {
    expect(pairedColourGroups({ plain: ["White"], ink: ["Black"], blackInk: ["Black"] })).toEqual({
      black: ["White", "Black"],
      white: [],
    });
  });
});

describe("planPairedDesignColours", () => {
  it("prints the black half on plain + black-ink colours only", () => {
    const plan = planPairedDesignColours("black", PRODUCT);

    expect(plan.colors).toEqual(["White", "Natural", "Black", "Navy"]);
    expect(plan.groups).toEqual([
      { ink: "main", colors: ["White", "Natural", "Black", "Navy"] },
    ]);
    // The partner IS the white artwork, so nothing is missing.
    expect(plan.missing).toEqual([]);
    expect(plan.usesInkArtwork).toBe(true);
  });

  it("prints the white half on the remaining ink colours only", () => {
    const plan = planPairedDesignColours("white", PRODUCT);

    expect(plan.colors).toEqual(["Red"]);
    expect(plan.groups).toEqual([{ ink: "main", colors: ["Red"] }]);
    expect(plan.missing).toEqual([]);
  });

  it("plans nothing for a half with no colours of its own", () => {
    const plan = planPairedDesignColours("white", {
      plain: ["White"],
      ink: ["Black"],
      blackInk: ["Black"],
    });

    expect(plan.groups).toEqual([]);
    expect(plan.colors).toEqual([]);
  });

  it("covers every product colour exactly once across the two halves", () => {
    const all = [
      ...planPairedDesignColours("black", PRODUCT).groups,
      ...planPairedDesignColours("white", PRODUCT).groups,
    ].flatMap((group) => group.colors);

    expect(hasDuplicates(all)).toBe(false);
    expect([...all].sort()).toEqual([...PRODUCT_COLOURS].sort());
  });
});

describe("the pair itself", () => {
  const PAIR = { blackInkDesignId: "d-black", whiteInkDesignId: "d-white" };

  it("finds each design's role", () => {
    expect(pairForDesign([PAIR], "d-black")).toEqual({ pair: PAIR, role: "black" });
    expect(pairForDesign([PAIR], "d-white")).toEqual({ pair: PAIR, role: "white" });
    expect(pairForDesign([PAIR], "d-other")).toBeUndefined();
  });

  it("lists every paired design once", () => {
    expect(pairedDesignIds([PAIR])).toEqual(["d-black", "d-white"]);
  });

  it("keeps a design in ONE pair when it is paired again", () => {
    const first = withInkPair([], "a", "b");
    const second = withInkPair(first, "b", "c");

    expect(second).toEqual([{ blackInkDesignId: "b", whiteInkDesignId: "c" }]);
    expect(pairForDesign(second, "b")?.role).toBe("black");
  });

  it("swaps the roles without changing the partner", () => {
    const swapped = setInkPairRole([PAIR], "d-white", "black");

    expect(swapped).toEqual([{ blackInkDesignId: "d-white", whiteInkDesignId: "d-black" }]);
    expect(pairForDesign(swapped, "d-white")?.role).toBe("black");
  });

  it("leaves other pairs alone when one role moves", () => {
    const other = { blackInkDesignId: "x", whiteInkDesignId: "y" };
    expect(setInkPairRole([PAIR, other], "d-black", "white")).toContainEqual(other);
  });

  it("drops the pair from either side", () => {
    expect(withoutInkPair([PAIR], "d-black")).toEqual([]);
    expect(withoutInkPair([PAIR], "d-white")).toEqual([]);
    expect(withoutInkPair([PAIR], "d-other")).toEqual([PAIR]);
  });
});
