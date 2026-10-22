// ---------------------------------------------------------------------------
// Printing the designs on ONE product.
//
// A product has ONE set of colours, and the user splits them into two groups:
//
//   plain - printed with ONE artwork (the design's main file)
//   ink   - printed with the ink artwork: black ink on some of them, white
//           ink on the rest
//
// WHICH DESIGN gets the ink artwork is the USER'S decision, not the app's.
// The Designs tab gives every design a checkbox ("Ink variants"); the ids the
// user ticked are stored in `session.inkPairIds` and are the only thing that
// separates the two rows. Nothing here infers a pairing from the artwork on
// file, from the product, or from the colours.
//
// The rule that stops a design printing on nothing:
//
//   A design the user PAIRED prints the ink artwork on the ink colours and
//   its main artwork on the plain ones.
//
//   A design the user did NOT pair prints its MAIN artwork on every colour of
//   the product. That is a choice, not a defect, so it is never reported as
//   one - the design covers every colour.
//
// Every function here is pure, so the rule can be unit-tested without a
// browser, a catalogue or a Printify account.
// ---------------------------------------------------------------------------

/** Which artwork a group prints. */
export type DesignInk = "main" | "black" | "white";

/** The colour groups of ONE product. */
export interface ProductColourGroups {
  /** Colours printed with one artwork (the design's main file). */
  plain: string[];
  /** Colours printed with the ink artwork. */
  ink: string[];
  /** The ink colours printed with the BLACK ink; the rest use the white ink. */
  blackInk: string[];
}

/** The ink artwork a design actually has. */
export interface DesignInkArtwork {
  /**
   * True when the USER ticked this design as "has ink variants".
   *
   * This is the whole separation: an unticked design prints one artwork
   * everywhere, whatever ink files happen to be on disk.
   */
  hasInkPair: boolean;
  hasBlackInk: boolean;
  hasWhiteInk: boolean;
}

/** What one design needs from one product. */
export interface DesignColourPlan {
  /** The artwork groups. The order is stable: main, black, white. */
  groups: Array<{ ink: DesignInk; colors: string[] }>;
  /**
   * The ink colours this design cannot print correctly with.
   *
   * Empty means the design can serve this product as it stands. A missing
   * entry means the artwork would be invisible on those garments. It is only
   * ever non-empty for a design the user PAIRED: an unpaired design prints
   * its main artwork everywhere on purpose.
   */
  missing: Array<{ ink: "black" | "white"; colors: string[] }>;
  /** True when the design contributes ink artwork to this product. */
  usesInkArtwork: boolean;
  /** Every colour of the product this design will be printed on. */
  colors: string[];
}

/** A design as far as the separation is concerned. */
export interface SeparableDesign {
  id: string;
  name: string;
  whiteInkAssetId?: string;
  blackInkAssetId?: string;
}

/** Removes duplicates while keeping the order. */
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * The product's colour groups, cleaned up.
 *
 * A colour cannot be in both groups, and only a colour that IS in the ink
 * group can carry an ink. Anything else in `blackInk` is ignored: it names a
 * colour the product does not print with the ink artwork at all.
 */
export function normaliseColourGroups(groups: ProductColourGroups): {
  plain: string[];
  ink: string[];
  black: string[];
  white: string[];
} {
  const plain = unique(groups.plain);
  const ink = unique(groups.ink).filter((c) => !plain.includes(c));
  const black = ink.filter((c) => groups.blackInk.includes(c));
  const white = ink.filter((c) => !groups.blackInk.includes(c));
  return { plain, ink, black, white };
}

/**
 * What one design needs from one product.
 *
 * The groups are always a complete cover of the product's colours: every
 * colour of the product is printed by exactly one group of every design.
 * That is what stops a design from silently printing on nothing.
 */
export function planDesignColours(
  artwork: DesignInkArtwork,
  groups: ProductColourGroups,
): DesignColourPlan {
  const { plain, black, white } = normaliseColourGroups(groups);
  const everything = unique([...plain, ...black, ...white]);

  // Not paired: one artwork, every colour. This is the user's own choice, so
  // nothing is missing and nothing is reported.
  if (!artwork.hasInkPair) {
    return {
      groups: everything.length > 0 ? [{ ink: "main", colors: everything }] : [],
      missing: [],
      usesInkArtwork: false,
      colors: everything,
    };
  }

  // Paired: the ink artwork is used where the product actually needs it.
  const useBlack = artwork.hasBlackInk && black.length > 0;
  const useWhite = artwork.hasWhiteInk && white.length > 0;

  // Everything the ink artwork does not cover prints with the main artwork:
  // the plain colours, and any ink colour this design has no artwork for.
  const mainColors = unique([
    ...plain,
    ...(useBlack ? [] : black),
    ...(useWhite ? [] : white),
  ]);

  const planGroups: Array<{ ink: DesignInk; colors: string[] }> = [];
  if (mainColors.length > 0) planGroups.push({ ink: "main", colors: mainColors });
  if (useBlack) planGroups.push({ ink: "black", colors: black });
  if (useWhite) planGroups.push({ ink: "white", colors: white });

  const missing: Array<{ ink: "black" | "white"; colors: string[] }> = [];
  if (!artwork.hasBlackInk && black.length > 0) missing.push({ ink: "black", colors: black });
  if (!artwork.hasWhiteInk && white.length > 0) missing.push({ ink: "white", colors: white });

  return {
    groups: planGroups,
    missing,
    usesInkArtwork: useBlack || useWhite,
    colors: everything,
  };
}

/** True when the user marked this design as "has ink variants". */
export function isInkPair(inkPairIds: readonly string[], designId: string): boolean {
  return inkPairIds.includes(designId);
}

/**
 * Splits the designs into the two rows the gallery draws.
 *
 * The split is exactly the user's ticks: a design is in "Has ink variants"
 * when its id is in `inkPairIds`, and in "No ink variants" otherwise. There
 * is no fallback and no inference - an id that no longer belongs to a design
 * is simply ignored.
 */
export function splitDesignsByInkPair<T extends SeparableDesign>(
  designs: T[],
  inkPairIds: readonly string[],
): { plain: T[]; ink: T[] } {
  const paired = new Set(inkPairIds);
  const plain: T[] = [];
  const ink: T[] = [];
  for (const design of designs) {
    if (paired.has(design.id)) ink.push(design);
    else plain.push(design);
  }
  return { plain, ink };
}

/** A design that cannot print some of the product's ink colours. */
export interface InkArtworkProblem {
  designId: string;
  designName: string;
  ink: "black" | "white";
  /** The colours that would print wrong. */
  colors: string[];
}

/**
 * The paired designs whose ink artwork does not cover the product's ink
 * colours.
 *
 * A paired design with no black-ink artwork on a colour the user marked for
 * the black ink prints the main artwork there, which is usually invisible on
 * a dark garment. This is the check that says so in plain words instead of
 * letting the partition fail with "132 variants are not in any group".
 *
 * Unpaired designs are never reported: printing the main artwork everywhere
 * is what the user asked for by leaving the box unticked.
 */
export function inkArtworkProblems<T extends SeparableDesign>(
  designs: T[],
  groups: ProductColourGroups,
  inkPairIds: readonly string[],
): InkArtworkProblem[] {
  const problems: InkArtworkProblem[] = [];
  for (const design of designs) {
    const plan = planDesignColours(
      {
        hasInkPair: isInkPair(inkPairIds, design.id),
        hasBlackInk: Boolean(design.blackInkAssetId),
        hasWhiteInk: Boolean(design.whiteInkAssetId),
      },
      groups,
    );
    for (const entry of plan.missing) {
      if (entry.colors.length === 0) continue;
      problems.push({
        designId: design.id,
        designName: design.name,
        ink: entry.ink,
        colors: entry.colors,
      });
    }
  }
  return problems;
}
