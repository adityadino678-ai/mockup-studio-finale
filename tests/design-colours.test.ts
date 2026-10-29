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
  summariseColourGroups,
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
// The two colour panels are INDEPENDENT, and that is the whole rule:
//
//   A design the user did NOT tick prints its MAIN artwork on the "No ink
//   variants" panel's colours and on NOTHING else.
//
//   A design the user DID tick prints the "Has ink variants" panel's colours
//   and on NOTHING else: the black-ink colours with its black artwork, the
//   rest with its white artwork. It is reported when its ink artwork cannot
//   cover them.
//
// A colour may sit in BOTH panels on purpose - the two rows are different
// products, so each prints it with its own artwork. Nothing is merged and
// nothing is stripped.
//
// Why "exactly once" is still pinned so hard: Printify REWRITES an incomplete
// partition and then prints the WRONG artwork on the variants it silently
// appended, so a design that covers a colour twice - or the WRONG panel's
// colours - is a real production bug, not a cosmetic one.
// ---------------------------------------------------------------------------

/** A product with a plain panel, a black-ink half and a white-ink half. */
const PRODUCT: ProductColourGroups = {
  plain: ["White", "Natural"],
  ink: ["Black", "Navy", "Red"],
  blackInk: ["Black", "Navy"],
};

/** The colours the plain panel owns. */
const PLAIN_COLOURS = ["White", "Natural"];

/** The colours the ink panel owns, black first then white. */
const INK_COLOURS = ["Black", "Navy", "Red"];

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
  it("keeps a colour that is in BOTH panels in both panels", () => {
    // "B" was put in both panels on purpose. The two rows are different
    // products, so the plain design prints its main artwork on B and the ink
    // design prints its ink artwork there. Nothing is stripped from either
    // panel - stripping is exactly what put every shirt on the black-ink
    // design and left the white-ink design with one colour.
    const normalised = normaliseColourGroups({
      plain: ["A", "B"],
      ink: ["B", "C"],
      blackInk: ["C"],
    });

    expect(normalised.plain).toEqual(["A", "B"]);
    expect(normalised.ink).toEqual(["B", "C"]);
    expect(normalised.black).toEqual(["C"]);
    expect(normalised.white).toEqual(["B"]);
  });

  it("splits the ink panel by the ink each colour was marked with", () => {
    // "B" is in both panels AND marked for the black ink. Inside the ink
    // panel it belongs to the black half; the plain panel keeps it untouched.
    const normalised = normaliseColourGroups({
      plain: ["A", "B"],
      ink: ["B", "C"],
      blackInk: ["B"],
    });

    expect(normalised.plain).toEqual(["A", "B"]);
    expect(normalised.black).toEqual(["B"]);
    expect(normalised.white).toEqual(["C"]);
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

/**
 * The real case this fix is about: the user picks four colours for the black
 * ink, four for the white ink and a few plain ones. Every one of them must
 * appear in the plan exactly once.
 */
const FOUR_AND_FOUR: ProductColourGroups = {
  plain: ["Solid White", "Natural", "Sand"],
  ink: [
    "Solid Black",
    "Navy",
    "Charcoal",
    "Forest",
    "Red",
    "Burgundy",
    "Maroon",
    "Mustard",
  ],
  blackInk: ["Solid Black", "Navy", "Charcoal", "Forest"],
};

const FOUR_AND_FOUR_INK = [
  "Solid Black",
  "Navy",
  "Charcoal",
  "Forest",
  "Red",
  "Burgundy",
  "Maroon",
  "Mustard",
];

describe("planDesignColours - four black-ink and four white-ink colours", () => {
  it("keeps all eight ink colours and puts each in the group that owns its artwork", () => {
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      FOUR_AND_FOUR,
    );

    const black = plan.groups.find((group) => group.ink === "black");
    const white = plan.groups.find((group) => group.ink === "white");
    expect(black?.colors).toEqual(FOUR_AND_FOUR.blackInk);
    expect(black?.colors).toHaveLength(4);
    expect(white?.colors).toHaveLength(4);
    expect([...(black?.colors ?? []), ...(white?.colors ?? [])].sort()).toEqual(
      [...FOUR_AND_FOUR.ink].sort(),
    );
    // No ink colour was silently dropped from the plan.
    for (const colour of FOUR_AND_FOUR.ink) expect(plan.colors).toContain(colour);
    expect(plan.colors).toEqual(FOUR_AND_FOUR_INK);
    expect(hasDuplicates(plan.colors)).toBe(false);
  });

  it("never reaches into the plain panel - a ticked design prints the ink panel only", () => {
    // The two panels are independent. The plain colours belong to the
    // no-ink-variants designs; handing them to the ink design is what put
    // every shirt on the black-ink design.
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      FOUR_AND_FOUR,
    );

    for (const colour of FOUR_AND_FOUR.plain) expect(plan.colors).not.toContain(colour);
    expect(plan.groups.find((group) => group.ink === "main")).toBeUndefined();
  });

  it("keeps a colour that is in BOTH panels in the ink design's own panel", () => {
    // "Solid Black" is in both panels. The plain design prints its main
    // artwork there; THIS design prints its black ink there. Both are right.
    const bothRows: ProductColourGroups = {
      plain: ["Solid White", "Solid Black"],
      ink: ["Solid Black", "Navy"],
      blackInk: ["Solid Black"],
    };
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      bothRows,
    );

    expect(plan.groups).toEqual([
      { ink: "black", colors: ["Solid Black"] },
      { ink: "white", colors: ["Navy"] },
    ]);
    expect(plan.colors).toEqual(["Solid Black", "Navy"]);
  });
});

describe("summariseColourGroups", () => {
  it("counts each panel separately and names the overlap neutrally", () => {
    // "B" is in both panels: the plain design prints its main artwork there,
    // the ink design its ink artwork. Both panels keep it.
    expect(
      summariseColourGroups({
        plain: ["A", "B"],
        ink: ["B", "C"],
        blackInk: ["B"],
      }),
    ).toEqual({ plain: 2, black: 1, white: 1, total: 3, overlap: ["B"] });
  });

  it("reports the four-and-four case without an overlap", () => {
    const summary = summariseColourGroups(FOUR_AND_FOUR);

    expect(summary).toEqual({
      plain: 3,
      black: 4,
      white: 4,
      total: 11,
      overlap: [],
    });
  });

  it("names every colour that is in both panels, in plain-panel order", () => {
    const summary = summariseColourGroups({
      plain: ["C", "A", "B"],
      ink: ["B", "C"],
      blackInk: [],
    });

    expect(summary.overlap).toEqual(["C", "B"]);
    expect(summary.total).toBe(3);
  });
});

describe("planDesignColours - a design the user did NOT tick", () => {
  it("prints the main artwork on the plain panel's colours only", () => {
    // THE PANEL DECIDES THE COLOURS. This design is in the "No ink variants"
    // row, so it prints the "No ink variants" panel and nothing else. The ink
    // panel's colours belong to the ink designs.
    const plan = planDesignColours(
      { hasInkPair: false, hasBlackInk: false, hasWhiteInk: false },
      PRODUCT,
    );

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].ink).toBe("main");
    expect(plan.groups[0].colors).toEqual(PLAIN_COLOURS);
    expect(plan.colors).toEqual(PLAIN_COLOURS);
  });

  it("never uses ink artwork, and never reports a missing ink", () => {
    // Unticked is a CHOICE: the design prints one artwork on its own panel,
    // so there is nothing wrong to report.
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

    expect(plan.groups).toEqual([{ ink: "main", colors: PLAIN_COLOURS }]);
    expect(plan.usesInkArtwork).toBe(false);
    expect(plan.missing).toEqual([]);
  });

  it("plans nothing when the plain panel is empty", () => {
    // Nothing to print. The Studio blocks the batch with a message naming
    // this design and the panel, rather than creating a product on nothing.
    const plan = planDesignColours(
      { hasInkPair: false, hasBlackInk: true, hasWhiteInk: true },
      { plain: [], ink: ["Black"], blackInk: ["Black"] },
    );

    expect(plan.groups).toEqual([]);
    expect(plan.colors).toEqual([]);
  });
});

describe("planDesignColours - a design the user DID tick", () => {
  it("gets one group per ink, from the ink panel", () => {
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      PRODUCT,
    );

    expect(plan.groups).toEqual([
      { ink: "black", colors: ["Black", "Navy"] },
      { ink: "white", colors: ["Red"] },
    ]);
    expect(plan.usesInkArtwork).toBe(true);
    expect(plan.missing).toEqual([]);
  });

  it("covers its own panel exactly once and never the plain panel", () => {
    // Printify silently completes an incomplete partition and then prints
    // the WRONG artwork, so an overlap or a gap here is a real bug.
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      PRODUCT,
    );
    const all = plan.groups.flatMap((group) => group.colors);

    expect([...all].sort()).toEqual([...INK_COLOURS].sort());
    expect(hasDuplicates(all)).toBe(false);
    expect(plan.colors).toEqual(INK_COLOURS);
  });

  it("does NOT fall back to main artwork when ink artwork is missing - those colours don't print", () => {
    // NEW BEHAVIOR: no fallback. Missing ink colours are reported in `missing`
    // but do NOT get a group. The user is warned, and those colours simply
    // won't be printed on the product.
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: false },
      PRODUCT,
    );

    // Only black ink group - white ink colours have no artwork, so no group
    expect(plan.groups).toEqual([
      { ink: "black", colors: ["Black", "Navy"] },
    ]);
    // White ink colours are reported as missing
    expect(plan.missing).toEqual([{ ink: "white", colors: ["Red"] }]);
    // Only black ink colours are in the plan's colors
    expect(plan.colors).toEqual(["Black", "Navy"]);
    expect(plan.usesInkArtwork).toBe(true);
  });

  it("plans nothing when the ink panel is empty", () => {
    const emptyInk: ProductColourGroups = { plain: ["White"], ink: [], blackInk: [] };
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      emptyInk,
    );

    expect(plan.usesInkArtwork).toBe(false);
    expect(plan.groups).toEqual([]);
    expect(plan.colors).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("does not report a missing ink the product never needs", () => {
    // The design only has a black-ink file and the ink panel only prints with
    // the white ink: nothing is missing that the product could use.
    const plan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: false },
      WHITE_INK_ONLY,
    );

    // No black ink colours in the panel, no white ink artwork
    expect(plan.groups).toEqual([]);
    expect(plan.missing).toEqual([{ ink: "white", colors: ["Red"] }]);
    expect(plan.colors).toEqual([]);
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

    // The plain panel is not this design's panel, so it contributes no group.
    expect(plan.groups.map((group) => group.ink)).toEqual(["black", "white"]);
    expect(plan.groups.find((group) => group.ink === "black")?.colors).toEqual(["Black"]);
    expect(plan.groups.find((group) => group.ink === "white")?.colors).toEqual(["Red"]);
  });
});

describe("planDesignColours - every design covers exactly its own panel", () => {
  it("covers exactly the colours it has artwork for, from its own panel", () => {
    const designs = [NO_INK, BOTH_INKS, BLACK_ONLY, WHITE_ONLY];
    const ticked = new Set(["d-both", "d-white"]);

    for (const design of designs) {
      const isTicked = ticked.has(design.id);
      const plan = planDesignColours(
        {
          hasInkPair: isTicked,
          hasBlackInk: Boolean(design.blackInkAssetId),
          hasWhiteInk: Boolean(design.whiteInkAssetId),
        },
        PRODUCT,
      );
      const all = plan.groups.flatMap((group) => group.colors);
      // A design only covers colours it has artwork for (or plain panel if not ticked)
      const expectedOwn = isTicked
        ? (design.blackInkAssetId && design.whiteInkAssetId ? INK_COLOURS
            : design.blackInkAssetId ? INK_COLOURS.filter(c => PRODUCT.blackInk.includes(c))
            : design.whiteInkAssetId ? INK_COLOURS.filter(c => !PRODUCT.blackInk.includes(c))
            : [])
        : PLAIN_COLOURS;

      expect([...all].sort()).toEqual([...expectedOwn].sort());
      expect(hasDuplicates(all)).toBe(false);
    }
  });

  it("never mixes the two panels across a batch", () => {
    // The whole point: a plain design and an ink design are different
    // products, so their colour sets must be disjoint here (PRODUCT has no
    // colour in both panels). If a plain design ever picked up an ink colour
    // the black-ink design would lose it.
    const plainPlan = planDesignColours(
      { hasInkPair: false, hasBlackInk: false, hasWhiteInk: false },
      PRODUCT,
    );
    const inkPlan = planDesignColours(
      { hasInkPair: true, hasBlackInk: true, hasWhiteInk: true },
      PRODUCT,
    );

    const overlap = plainPlan.colors.filter((c) => inkPlan.colors.includes(c));
    expect(overlap).toEqual([]);
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
// other the white-ink artwork. Both halves live in the "Has ink variants"
// panel, so the pair takes THAT panel and only that panel: the black half
// covers the colours marked Black ink, the white half the rest. The plain
// panel belongs to the no-ink-variants designs and is handed to neither half.
// ---------------------------------------------------------------------------

describe("pairedColourGroups", () => {
  it("gives only the ink panel's colours to the halves, split by the switch", () => {
    expect(pairedColourGroups(PRODUCT)).toEqual({
      black: ["Black", "Navy"],
      white: ["Red"],
    });
  });

  it("never puts a colour in both halves", () => {
    const split = pairedColourGroups(PRODUCT);
    expect(hasDuplicates([...split.black, ...split.white])).toBe(false);
    expect([...split.black, ...split.white].sort()).toEqual([...INK_COLOURS].sort());
  });

  it("keeps the plain panel out of the pair entirely", () => {
    const split = pairedColourGroups(PRODUCT);
    for (const colour of PLAIN_COLOURS) {
      expect(split.black).not.toContain(colour);
      expect(split.white).not.toContain(colour);
    }
  });

  it("has no white half when every ink colour uses black ink", () => {
    expect(pairedColourGroups({ plain: ["White"], ink: ["Black"], blackInk: ["Black"] })).toEqual({
      black: ["Black"],
      white: [],
    });
  });
});

describe("planPairedDesignColours", () => {
  it("prints the black half on the black-ink colours only", () => {
    const plan = planPairedDesignColours("black", PRODUCT);

    expect(plan.colors).toEqual(["Black", "Navy"]);
    expect(plan.groups).toEqual([{ ink: "main", colors: ["Black", "Navy"] }]);
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

  it("covers the ink panel exactly once across the two halves", () => {
    const all = [
      ...planPairedDesignColours("black", PRODUCT).groups,
      ...planPairedDesignColours("white", PRODUCT).groups,
    ].flatMap((group) => group.colors);

    expect(hasDuplicates(all)).toBe(false);
    expect([...all].sort()).toEqual([...INK_COLOURS].sort());
  });

  it("leaves the plain panel to the no-ink-variants designs", () => {
    const all = [
      ...planPairedDesignColours("black", PRODUCT).colors,
      ...planPairedDesignColours("white", PRODUCT).colors,
    ];

    for (const colour of PLAIN_COLOURS) expect(all).not.toContain(colour);
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
