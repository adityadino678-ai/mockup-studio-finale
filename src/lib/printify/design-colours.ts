// ---------------------------------------------------------------------------
// Printing the designs on ONE product.
//
// A product has ONE set of colours, and the user splits them across TWO
// INDEPENDENT panels in the Colors tab:
//
//   plain - the "No ink variants" panel: the colours printed with ONE artwork
//           (the design's main file)
//   ink   - the "Has ink variants" panel: the colours printed with the ink
//           artwork, BLACK ink on the colours marked black and WHITE ink on
//           the rest
//
// THE PANEL IS THE WHOLE RULE. A design in the "No ink variants" row prints
// only the colours of the plain panel; a design in the "Has ink variants" row
// prints only the colours of the ink panel. Neither row reaches into the
// other panel - that was the bug that put every shirt on the black-ink
// design and left the white-ink design with one colour.
//
// A colour MAY sit in both panels on purpose: the two rows are different
// products, so the plain design prints its main artwork on that colour while
// the ink design prints its ink artwork. Both are correct; nothing is merged.
//
// WHICH DESIGN gets the ink artwork is the USER'S decision, not the app's.
// The Designs tab gives every design a checkbox ("Ink variants"); the ids the
// user ticked are stored in `session.inkPairIds` and are the only thing that
// separates the two rows. Nothing here infers a pairing from the artwork on
// file, from the product, or from the colours.
//
// WHICH COLOUR gets which ink is also the user's, set per colour with the
// Black ink / White ink switch in the Colors tab (`session.rows.ink.blackInkColors`).
//
// Two UPLOADED designs can also be paired as one listing (`session.inkPairs`):
// one supplies the black-ink artwork, the other the white-ink artwork. The
// black half covers the colours marked for black ink, the white half the rest
// of the ink panel, and the pair creates ONE product. See `pairedColourGroups`.
//
// Every function here is pure, so the rule can be unit-tested without a
// browser, a catalogue or a Printify account.
// ---------------------------------------------------------------------------

import type { StudioSession } from "@/types/domain";

/** Which artwork a group prints. */
export type DesignInk = "main" | "black" | "white";

/** The colour groups of ONE product. */
export interface ProductColourGroups {
  /** Colours printed with one artwork (the design's main file). */
  plain: string[];
  /** Colours printed with the ink artwork. */
  ink: string[];
  /** The ink colours printed with the BLACK ink. */
  blackInk: string[];
  /**
   * The ink colours printed with the WHITE ink, when the caller knows them
   * explicitly. Omit it for legacy callers: white then means "every ink colour
   * not marked black". The Studio always supplies it.
   */
  whiteInk?: string[];
}

/**
 * The colour groups of the ONE product in the session.
 *
 * The colours are split into two groups ONCE, in the Colors tab, and every
 * other view reads them from here. Keeping this function in the pure module
 * means the Studio plan, the autopilot and the listing views cannot disagree
 * about which colours print with which artwork.
 */
export function productColourGroups(session: StudioSession): ProductColourGroups {
  return {
    plain: session.rows.plain?.colors ?? [],
    ink: session.rows.ink?.colors ?? [],
    blackInk: session.rows.ink?.blackInkColors ?? [],
    // Explicit, so a colour with no ink choice cannot be read as white by the
    // artwork problems, the colour summary or the listing preview.
    whiteInk: session.rows.ink?.whiteInkColors ?? [],
  };
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
   * ever non-empty for a design the user TICKED "Ink variants": an unticked
   * design prints its main artwork on the plain panel on purpose.
   */
  missing: Array<{ ink: "black" | "white"; colors: string[] }>;
  /** True when the design contributes ink artwork to this product. */
  usesInkArtwork: boolean;
  /**
   * Ink-panel colours the user has not marked Black or White. They print on
   * nothing until decided; the plan blocks creation while this is non-empty.
   */
  undecided: string[];
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
 * The two panels are INDEPENDENT, so a colour may appear in both and that is
 * allowed: the plain row's design prints its main artwork there, the ink
 * row's design prints its ink artwork. This normalisation only removes
 * duplicates inside a panel and derives the black/white split from
 * `blackInk`; it never moves a colour from one panel to the other.
 *
 * Only a colour that IS in the ink group can carry an ink. Anything else in
 * `blackInk` is ignored: it names a colour the product does not print with
 * the ink artwork at all.
 */
export function normaliseColourGroups(groups: ProductColourGroups): {
  plain: string[];
  ink: string[];
  black: string[];
  white: string[];
  undecided: string[];
} {
  const ink = unique(groups.ink);
  const plain = unique(groups.plain);
  const black = ink.filter((c) => groups.blackInk.includes(c));
  // Explicit white when the caller supplies it; legacy implicit white otherwise.
  const white = groups.whiteInk
    ? ink.filter((c) => groups.whiteInk!.includes(c) && !black.includes(c))
    : ink.filter((c) => !black.includes(c));
  const undecided = ink.filter((c) => !black.includes(c) && !white.includes(c));
  return { plain, ink, black, white, undecided };
}

/** The counts the Design panel reports for a listing's colour plan. */
export interface ColourGroupSummary {
  /** Colours printed with the main artwork only (the "No ink variants" panel). */
  plain: number;
  /** Ink colours printed with the black-ink artwork. */
  black: number;
  /** Ink colours printed with the white-ink artwork. */
  white: number;
  /** Ink colours the user has not marked Black or White. They print on nothing. */
  undecided: number;
  /** Every colour of the product, counted once (the union of both panels). */
  total: number;
  /**
   * Colours the user put in BOTH panels. That is allowed and intentional:
   * the plain design prints its main artwork there, the ink design prints its
   * ink artwork. This list exists so the panel can say so out loud.
   */
  overlap: string[];
}

/**
 * The colour counts for the Design panel's summary line.
 *
 * It uses the same normalisation as the plan, so the numbers cannot disagree
 * with what will actually be created: black + white is the whole ink panel,
 * plain is the whole plain panel, and `total` is the union of the two.
 */
export function summariseColourGroups(groups: ProductColourGroups): ColourGroupSummary {
  const { plain, ink, black, white, undecided } = normaliseColourGroups(groups);
  const inkSet = new Set(ink);
  return {
    plain: plain.length,
    black: black.length,
    white: white.length,
    undecided: undecided.length,
    total: unique([...plain, ...ink]).length,
    overlap: plain.filter((c) => inkSet.has(c)),
  };
}

/**
 * What one design needs from one product.
 *
 * THE PANEL DECIDES THE COLOURS. A design the user did not tick gets the
 * plain panel only; a design the user ticked gets the ink panel only. A
 * design therefore prints exactly the colours of ITS OWN panel - never the
 * other panel's, and never "every colour of the product".
 *
 * An empty colour set is the caller's problem to report, not to paper over:
 * `studioPlanProblems` blocks the batch when a design's own panel is empty,
 * so nothing is ever created half-right.
 *
 * NO FALLBACK: if an ink-ticked design lacks black/white artwork, those
 * colours simply do NOT print - they are reported in `missing` and the
 * user is warned. The main artwork is NEVER used for ink panel colours.
 */
export function planDesignColours(
  artwork: DesignInkArtwork,
  groups: ProductColourGroups,
): DesignColourPlan {
  const { plain, black, white, undecided } = normaliseColourGroups(groups);

  // Not ticked: ONE artwork, on the plain panel's colours and nowhere else.
  if (!artwork.hasInkPair) {
    return {
      groups: plain.length > 0 ? [{ ink: "main", colors: plain }] : [],
      missing: [],
      usesInkArtwork: false,
      undecided: [],
      colors: plain,
    };
  }

  // TICKED: the ink panel's colours ONLY, and never the plain panel's.
  // Each ink group is created ONLY when BOTH the artwork exists AND
  // the user selected colours for that ink. No fallback to main artwork.
  const planGroups: Array<{ ink: DesignInk; colors: string[] }> = [];
  const missing: Array<{ ink: "black" | "white"; colors: string[] }> = [];

  // Black ink group - ONLY if design has black ink artwork AND user selected black ink colours
  if (artwork.hasBlackInk && black.length > 0) {
    planGroups.push({ ink: "black", colors: black });
  } else if (black.length > 0) {
    // User selected black ink colours but design has no black ink artwork
    missing.push({ ink: "black", colors: black });
  }

  // White ink group - ONLY if design has white ink artwork AND user selected white ink colours
  if (artwork.hasWhiteInk && white.length > 0) {
    planGroups.push({ ink: "white", colors: white });
  } else if (white.length > 0) {
    // User selected white ink colours but design has no white ink artwork
    missing.push({ ink: "white", colors: white });
  }

  // Only colours that will actually be printed (in groups)
  const colors = unique(planGroups.flatMap((g) => g.colors));

  return {
    groups: planGroups,
    missing,
    usesInkArtwork: planGroups.length > 0,
    undecided,
    colors,
  };
}

/** True when the user marked this design as "has ink variants". */
export function isInkPair(inkPairIds: readonly string[], designId: string): boolean {
  return inkPairIds.includes(designId);
}

// ---------------------------------------------------------------------------
// Pairing two uploaded designs
//
// A pair is two designs that print as ONE product: one carries the black-ink
// artwork, the other the white-ink artwork. The user creates it on the
// Designs tab; nothing here infers a partner.
// ---------------------------------------------------------------------------

/** Two designs that print as one product. */
export interface DesignInkPair {
  /** Printed on the colours marked for black ink. */
  blackInkDesignId: string;
  /** Printed on the remaining colours of the ink panel. */
  whiteInkDesignId: string;
}

/** Which half of a pair a design prints. */
export type InkPairRole = "black" | "white";

/** The pair a design belongs to, and the role it plays in it. */
export function pairForDesign(
  pairs: readonly DesignInkPair[],
  designId: string,
): { pair: DesignInkPair; role: InkPairRole } | undefined {
  for (const pair of pairs) {
    if (pair.blackInkDesignId === designId) return { pair, role: "black" };
    if (pair.whiteInkDesignId === designId) return { pair, role: "white" };
  }
  return undefined;
}

/** Every design that belongs to a pair, in pair order. */
export function pairedDesignIds(pairs: readonly DesignInkPair[]): string[] {
  return unique(pairs.flatMap((pair) => [pair.blackInkDesignId, pair.whiteInkDesignId]));
}

/**
 * Adds a pair, replacing any pair either design was already in.
 *
 * A design can be in ONE pair: it supplies one artwork for one product, and
 * letting it sit in two pairs would print it on two listings the user did not
 * ask for.
 */
export function withInkPair(
  pairs: readonly DesignInkPair[],
  blackInkDesignId: string,
  whiteInkDesignId: string,
): DesignInkPair[] {
  const touched = new Set([blackInkDesignId, whiteInkDesignId]);
  const kept = pairs.filter(
    (pair) =>
      !touched.has(pair.blackInkDesignId) && !touched.has(pair.whiteInkDesignId),
  );
  return [...kept, { blackInkDesignId, whiteInkDesignId }];
}

/** Moves a design to the other role inside its own pair. */
export function setInkPairRole(
  pairs: readonly DesignInkPair[],
  designId: string,
  role: InkPairRole,
): DesignInkPair[] {
  return pairs.map((pair) => {
    if (pair.blackInkDesignId !== designId && pair.whiteInkDesignId !== designId) return pair;
    const partner =
      pair.blackInkDesignId === designId ? pair.whiteInkDesignId : pair.blackInkDesignId;
    return role === "black"
      ? { blackInkDesignId: designId, whiteInkDesignId: partner }
      : { blackInkDesignId: partner, whiteInkDesignId: designId };
  });
}

/** Drops the pair a design belongs to. */
export function withoutInkPair(
  pairs: readonly DesignInkPair[],
  designId: string,
): DesignInkPair[] {
  return pairs.filter(
    (pair) => pair.blackInkDesignId !== designId && pair.whiteInkDesignId !== designId,
  );
}

/**
 * The colours a pair covers, split between its two artworks.
 *
 * Both halves live in the INK panel, so the pair takes that panel and only
 * that panel: the black-ink design covers the colours the user marked for
 * black ink, the white-ink design the rest of the ink panel, and any colour
 * not marked either way is undecided and prints on nothing. The plain panel
 * belongs to the no-ink-variants designs and is deliberately NOT handed to
 * either half.
 */
export function pairedColourGroups(groups: ProductColourGroups): {
  black: string[];
  white: string[];
  undecided: string[];
} {
  const { black, white, undecided } = normaliseColourGroups(groups);
  return { black, white, undecided };
}

/**
 * What ONE member of a pair prints.
 *
 * Unlike `planDesignColours`, this never reports a missing ink: the partner
 * design IS the artwork for the other half, so a pair is complete by
 * construction. The result is shaped like `DesignColourPlan` so the cards and
 * the swatches can treat both cases the same way.
 */
export function planPairedDesignColours(
  role: InkPairRole,
  groups: ProductColourGroups,
): DesignColourPlan {
  const split = pairedColourGroups(groups);
  const colors = role === "black" ? split.black : split.white;
  return {
    groups: colors.length > 0 ? [{ ink: "main", colors }] : [],
    missing: [],
    undecided: split.undecided,
    usesInkArtwork: true,
    colors,
  };
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
 * A ticked design with no black-ink artwork on a colour the user marked for
 * the black ink prints the main artwork there, which is usually invisible on
 * a dark garment. This is the check that says so in plain words instead of
 * letting the partition fail with "132 variants are not in any group".
 *
 * Unticked designs are never reported: printing the main artwork on the
 * plain panel is what the user asked for by leaving the box unticked.
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
