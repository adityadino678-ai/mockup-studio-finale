// ---------------------------------------------------------------------------
// Separating the designs for ONE product.
//
// A product has ONE set of colours, and the user splits them into two groups:
//
//   plain - printed with ONE artwork (the design's main file)
//   ink   - printed with the ink artwork: black ink on some of them, white
//           ink on the rest
//
// The designs are separated to MATCH that product. A design with ink artwork
// belongs with the ink colours; a design without belongs with the plain ones.
// So the separation is a property of (product, design) and not of the design
// alone:
//
//   - The same design can land in different groups for different products.
//   - For a product whose ink group is empty, NO design needs an ink artwork,
//     so every design is a "no ink variants" design for that product.
//
// The rule that stops a design printing on nothing:
//
//   A design WITH ink artwork prints the ink artwork on the ink colours and
//   its main artwork on the plain ones.
//
//   A design WITHOUT ink artwork prints its MAIN artwork on every colour of
//   the product. Its artwork is not "wrong" on the ink colours - it is simply
//   not tuned for them, so that is reported rather than hidden. The ink
//   colours are the ones the user chose because the garment is dark there,
//   and a design with no white-ink artwork would be invisible on them.
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
   * entry means the artwork would be invisible on those garments.
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

  // The ink artwork is only used where the product actually needs it.
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
    colors: unique([...plain, ...black, ...white]),
  };
}

/**
 * Splits the designs into the two groups, for ONE product.
 *
 * A design is in the "ink" group when it contributes ink artwork to THIS
 * product - it has the ink artwork, and the product's ink colours need that
 * ink. A design whose ink artwork the product never uses is a "no ink
 * variants" design here, even though it has ink artwork on file.
 */
export function splitDesignsByProduct<T extends SeparableDesign>(
  designs: T[],
  groups: ProductColourGroups,
): { plain: T[]; ink: T[] } {
  const plain: T[] = [];
  const ink: T[] = [];
  for (const design of designs) {
    const plan = planDesignColours(
      {
        hasBlackInk: Boolean(design.blackInkAssetId),
        hasWhiteInk: Boolean(design.whiteInkAssetId),
      },
      groups,
    );
    if (plan.usesInkArtwork) ink.push(design);
    else plain.push(design);
  }
  return { plain, ink };
}

/**
 * The split to show when NO product has been chosen yet.
 *
 * The Designs tab is where designs are uploaded and their ink variants are
 * made, and that happens BEFORE a product is chosen - so there is no product
 * to separate them by. In that state the only thing that can be said is
 * which designs have their own ink artwork on file.
 *
 * As soon as a product IS chosen, `splitDesignsByProduct` takes over and the
 * split follows that product instead.
 */
export function splitDesignsByInkArtwork<T extends SeparableDesign>(
  designs: T[],
): { plain: T[]; ink: T[] } {
  const plain: T[] = [];
  const ink: T[] = [];
  for (const design of designs) {
    if (design.whiteInkAssetId || design.blackInkAssetId) ink.push(design);
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
 * The designs whose ink artwork does not cover the product's ink colours.
 *
 * A missing black-ink artwork on a colour the user marked for the black ink
 * prints the main artwork there, which is usually invisible on a dark
 * garment. This is the check that says so in plain words instead of letting
 * the partition fail with "132 variants are not in any group".
 */
export function inkArtworkProblems<T extends SeparableDesign>(
  designs: T[],
  groups: ProductColourGroups,
): InkArtworkProblem[] {
  const problems: InkArtworkProblem[] = [];
  for (const design of designs) {
    const plan = planDesignColours(
      {
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

/**
 * The colours to move into the plain group so that nothing prints wrong.
 *
 * This is the one-click fix: a colour the product prints with the ink
 * artwork, on which some design has no ink artwork, is a colour that design
 * cannot serve. Moving it to the plain group makes every design able to
 * print it, with the main artwork.
 */
export function coloursToMoveToPlain(
  problems: InkArtworkProblem[],
): string[] {
  const moved = new Set<string>();
  for (const problem of problems) {
    for (const colour of problem.colors) moved.add(colour);
  }
  return [...moved];
}
