// ---------------------------------------------------------------------------
// What a Studio session will create, as pure data.
//
// The Studio used to build this plan inside a React `useMemo`. The listing
// autopilot needs exactly the same answer - which design owns which listing,
// which artwork goes on which colour, and whether the product can be built -
// so the plan lives here and both callers share it.
//
// The rules are unchanged from the Studio:
//
//   * only ticked designs are in scope;
//   * a complete pair is ONE product, owned by its black-ink half;
//   * THE PANEL DECIDES THE COLOURS: a design with no ink variants prints the
//     plain panel's colours, an ink design prints the ink panel's colours, and
//     neither row reaches into the other panel;
//   * a design whose OWN panel is empty prints on nothing, so the batch is
//     BLOCKED with a message that names the design and the panel - nothing is
//     ever created half-right;
//   * the partition must cover every variant and stay under Printify's cap.
// ---------------------------------------------------------------------------

import {
  inkArtworkProblems,
  normaliseColourGroups,
  pairedColourGroups,
  pairedDesignIds,
  planDesignColours,
  type InkArtworkProblem,
  type ProductColourGroups,
} from "./design-colours";
import { buildCatalogueIndex, buildPartition, resolveVariantIds } from "./variants";
import type { CatalogVariant, ColourIndex } from "./types";
import type { Design, StudioSession } from "@/types/domain";

/** Printify's limit for enabled variants on one product. */
export const MAX_STUDIO_VARIANTS = 100;

/** One artwork group of a design: which ink, which file, which colours. */
export interface StudioDesignGroup {
  ink: "main" | "black" | "white";
  assetId: string;
  colors: string[];
  label: string;
  /** True when the design has no ink file and the main design is used. */
  fallback: boolean;
}

/** One product the Studio will create. */
export interface StudioDesignPlan {
  /** The design that owns the listing (the black half for a pair). */
  designId: string;
  designName: string;
  /** The listing id: the owner design's id. */
  listingId: string;
  /** Every design this listing prints (one, or the two halves of a pair). */
  memberIds: string[];
  /** The other half of a pair, when this is a pair. */
  partnerDesignId?: string;
  partnerName?: string;
  row: "plain" | "ink";
  /**
   * True when the USER ticked "Ink variants" on this design (or it is half of
   * a pair), so it prints the "Has ink variants" panel.
   *
   * `row` alone cannot answer that: a ticked design whose ink panel is empty
   * has no ink artwork to use, so it falls back to the plain row's display -
   * but the panel it needs fixed is still the ink one.
   */
  inkTicked: boolean;
  groups: StudioDesignGroup[];
}

export interface StudioPlan {
  items: StudioDesignPlan[];
  colourIndex: ColourIndex;
  groups: ProductColourGroups;
}

/** The artwork a design prints by default. */
function mainAssetId(design: Design): string {
  return design.processedAssetId ?? design.originalAssetId;
}

/**
 * The Studio's product plan for one session.
 *
 * `variants` is the live catalogue for `(blueprint, printProvider)`. The
 * function is pure: it reads no React state, no storage and no network.
 */
export function buildStudioPlan(
  designs: Design[] | null | undefined,
  session: StudioSession,
  variants: CatalogVariant[],
): StudioPlan | null {
  if (!designs || !session.blueprintId || !session.printProviderId) return null;

  const colourIndex = buildCatalogueIndex(variants);
  const groups = {
    plain: session.rows.plain?.colors ?? [],
    ink: session.rows.ink?.colors ?? [],
    blackInk: session.rows.ink?.blackInkColors ?? [],
    whiteInk: session.rows.ink?.whiteInkColors ?? [],
  } satisfies ProductColourGroups;
  const split = pairedColourGroups(groups);
  const byId = new Map(designs.map((design) => [design.id, design]));
  const scoped = new Set(session.designIds);
  const items: StudioDesignPlan[] = [];
  const handled = new Set<string>();

  for (const pair of session.inkPairs ?? []) {
    if (handled.has(pair.blackInkDesignId) || handled.has(pair.whiteInkDesignId)) continue;
    if (!scoped.has(pair.blackInkDesignId) || !scoped.has(pair.whiteInkDesignId)) continue;
    const black = byId.get(pair.blackInkDesignId);
    const white = byId.get(pair.whiteInkDesignId);
    if (!black || !white) continue;
    handled.add(black.id);
    handled.add(white.id);

    const pairedGroups: StudioDesignGroup[] = [];
    // Each paired design uses its main artwork as the ink artwork.
    // Black half covers black-ink colours, white half covers white-ink colours.
    if (split.black.length > 0) {
      pairedGroups.push({
        ink: "main",
        assetId: mainAssetId(black),
        colors: split.black,
        label: `Black ink · ${black.name}`,
        fallback: false,
      });
    }
    if (split.white.length > 0) {
      pairedGroups.push({
        ink: "main",
        assetId: mainAssetId(white),
        colors: split.white,
        label: `White ink · ${white.name}`,
        fallback: false,
      });
    }
    items.push({
      designId: black.id,
      designName: black.name,
      listingId: black.id,
      memberIds: [black.id, white.id],
      partnerDesignId: white.id,
      partnerName: white.name,
      row: "ink",
      inkTicked: true,
      groups: pairedGroups,
    });
  }

  for (const design of designs) {
    if (!scoped.has(design.id)) continue;
    if (handled.has(design.id)) continue;
    const inkTicked = (session.inkPairIds ?? []).includes(design.id);
    const colourPlan = planDesignColours(
      {
        hasInkPair: inkTicked,
        hasBlackInk: Boolean(design.blackInkAssetId),
        hasWhiteInk: Boolean(design.whiteInkAssetId),
      },
      groups,
    );
    items.push({
      designId: design.id,
      designName: design.name,
      listingId: design.id,
      memberIds: [design.id],
      // `row` is the DISPLAY row, and it falls back to "plain" when the ticked
      // design has no ink artwork to use. `inkTicked` is what says which PANEL
      // the user wants this design to read from.
      row: colourPlan.usesInkArtwork ? "ink" : "plain",
      inkTicked,
      groups: colourPlan.groups.map((group) => {
        if (group.ink === "main") {
          return {
            ink: group.ink,
            assetId: mainAssetId(design),
            colors: group.colors,
            label: "Main design",
            fallback: false,
          };
        }
        const own = group.ink === "black" ? design.blackInkAssetId : design.whiteInkAssetId;
        return {
          ink: group.ink,
          assetId: own ?? mainAssetId(design),
          colors: group.colors,
          label: own
            ? group.ink === "black"
              ? "Black ink"
              : "White ink"
            : `${group.ink === "black" ? "Black" : "White"} ink (using the main design)`,
          fallback: !own,
        };
      }),
    });
  }

  return { items, colourIndex, groups };
}

/** The variant ids a plan item enables, with the session's sizes applied. */
export function planItemVariantIds(
  plan: StudioPlan,
  item: StudioDesignPlan,
  sizes: string[],
): number[] {
  return resolveVariantIds(
    plan.colourIndex,
    item.groups.flatMap((group) => group.colors),
    sizes,
  );
}

/**
 * Checks each group for colors that have zero matching variants in the selected
 * sizes. Returns a list of warnings the UI can surface.
 */
export function checkGroupVariantCoverage(
  plan: StudioPlan,
  item: StudioDesignPlan,
  sizes: string[],
): Array<{ ink: "main" | "black" | "white"; colors: string[] }> {
  const warnings: Array<{ ink: "main" | "black" | "white"; colors: string[] }> = [];
  for (const group of item.groups) {
    const variantIds = resolveVariantIds(plan.colourIndex, group.colors, sizes);
    if (variantIds.length === 0 && group.colors.length > 0) {
      warnings.push({ ink: group.ink, colors: group.colors });
    }
  }
  return warnings;
}

/** The enabled variant count for every plan item. */
export function planVariantCounts(plan: StudioPlan, sizes: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of plan.items) {
    counts.set(item.designId, planItemVariantIds(plan, item, sizes).length);
  }
  return counts;
}

/**
 * The API-level problems: the variant cap, or no matching variants.
 * The ink artwork problems above are the ones that say WHY a design cannot serve a colour.
 * Partition completeness is NOT required - we only cover user-selected colours.
 * Catalogue extras are left unclaimed and disabled via is_enabled: false.
 */
export function studioPartitionProblems(plan: StudioPlan, session: StudioSession): string[] {
  const found: string[] = [];
  for (const item of plan.items) {
    buildPartition(
      plan.colourIndex,
      item.groups.map((group) => ({ ink: group.ink, colors: group.colors })),
    );

    const enabled = planItemVariantIds(plan, item, session.sizes);
    if (enabled.length > MAX_STUDIO_VARIANTS) {
      found.push(
        `${item.designName}: ${enabled.length} variants - Printify allows at most ${MAX_STUDIO_VARIANTS} per product.`,
      );
    }
    if (enabled.length === 0) {
      found.push(`${item.designName}: no variants match the selected colours and sizes.`);
    }

    // Warn about groups that have colors but no matching variants in selected sizes
    const coverageWarnings = checkGroupVariantCoverage(plan, item, session.sizes);
    for (const warning of coverageWarnings) {
      const colourList = warning.colors.slice(0, 5).join(", ") + (warning.colors.length > 5 ? ", …" : "");
      found.push(
        `${item.designName}: ${warning.ink === "main" ? "Main" : warning.ink === "black" ? "Black ink" : "White ink"} group has colours (${colourList}) with no matching variants in the selected sizes — those colours will not be printed.`,
      );
    }
  }

  return found;
}

/**
 * Ink colours the user has not marked Black or White.
 *
 * A colour in the ink panel with no ink choice prints on NOTHING: the black
 * design only prints black-marked colours and the white design only
 * white-marked ones. Silently defaulting it to white is what put the wrong
 * design on a garment, so creation is blocked until every ink colour is decided.
 */
export function undecidedInkProblems(plan: StudioPlan): string[] {
  const { ink, undecided } = normaliseColourGroups(plan.groups);
  if (undecided.length === 0) return [];
  return [
    `${undecided.length} of ${ink.length} ink colour${ink.length === 1 ? "" : "s"} (${joinNames(
      undecided,
    )}) have no ink yet. In Colors, mark each one Black ink or White ink - until then it is not printed by any design.`,
  ];
}

/**
 * Everything that stops the plan from creating products.
 *
 * An undecided ink colour is the cause and any partition complaint is only the
 * symptom, so `undecidedInkProblems` comes first. Then come the ink artwork
 * problems: they name the cause ("no white-ink artwork on Black and Navy")
 * instead of only the partition symptom.
 *
 * Then come the EMPTY PANEL problems. Each panel feeds its own row, so a row
 * whose panel has no colours would print on nothing - and Printify would
 * quietly drop the product. Blocking here, with the design's name and the
 * exact panel to fix, is the only honest answer.
 */
export function studioPlanProblems(
  plan: StudioPlan,
  designs: Design[],
  session: StudioSession,
): string[] {
  const scope = new Set(session.designIds);
  const pairIds = pairedDesignIds(session.inkPairs ?? []);
  const artworkProblems = inkArtworkProblems(
    // A paired design is never "missing" its ink artwork: its partner IS the
    // artwork for the other half.
    designs.filter((design) => scope.has(design.id) && !pairIds.includes(design.id)),
    plan.groups,
    session.inkPairIds ?? [],
  );

  return [
    ...undecidedInkProblems(plan),
    ...artworkProblems.map(
      (problem) => `${problem.designName}: ${describeMissingInk(problem)}`,
    ),
    ...emptyPanelProblems(plan),
    ...studioPartitionProblems(plan, session),
  ];
}

/**
 * The designs whose OWN colour panel is empty.
 *
 * The two panels are independent, so a design prints only the colours of the
 * panel its row reads from. When that panel holds nothing the design would
 * create a product with no colours at all - which Printify refuses, and which
 * the user would only discover after a confusing upload failure. Name the
 * design and the panel instead.
 */
export function emptyPanelProblems(plan: StudioPlan): string[] {
  return plan.items
    .filter((item) => item.groups.length === 0)
    .map((item) =>
      // Branch on the TICK, not on `row`: a ticked design whose ink panel is
      // empty has no ink artwork to use, so it displays in the plain row -
      // but the panel that needs fixing is still the ink one.
      item.inkTicked
        ? `"${item.designName}" is in the Has ink variants row, but no colours are selected in the "Has ink variants" panel of Colors. Select colours there (and mark each one Black ink or White ink), or untick "Ink variants" to move it back.`
        : `"${item.designName}" is in the No ink variants row, but no colours are selected in the "No ink variants" panel of Colors. Select colours there, or tick "Ink variants" on this design to move it to the other panel.`,
    );
}

/** What is actually wrong with one design and one ink. */
export function describeMissingInk(problem: InkArtworkProblem): string {
  const colours = joinNames(problem.colors);
  if (problem.ink === "white") {
    return `this design has no white-ink artwork, so on ${colours} it would print with the main artwork - invisible on a dark garment.`;
  }
  return `this design has no black-ink artwork, so on ${colours} it would print with the main artwork - it was not prepared for the black ink.`;
}

/** "Black", "Black and Navy", "Black, Navy and White". */
function joinNames(names: string[]): string {
  if (names.length === 0) return "the ink colours";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
