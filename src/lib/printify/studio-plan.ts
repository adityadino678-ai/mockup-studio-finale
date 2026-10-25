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
//   * an unpaired design covers every colour (main artwork everywhere, or its
//     own ink artwork where the user ticked it);
//   * the partition must cover every variant and stay under Printify's cap.
// ---------------------------------------------------------------------------

import {
  inkArtworkProblems,
  pairedColourGroups,
  pairedDesignIds,
  planDesignColours,
  type InkArtworkProblem,
  type ProductColourGroups,
} from "./design-colours";
import { assertCompletePartition } from "./print-areas";
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
    // The absorber is the last group that holds variants, so the group that
    // can safely swallow the catalogue's hidden extras is the last non-empty
    // one. Both groups are complete by construction here.
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
        ink: "white",
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
      groups: pairedGroups,
    });
  }

  for (const design of designs) {
    if (!scoped.has(design.id)) continue;
    if (handled.has(design.id)) continue;
    const colourPlan = planDesignColours(
      {
        hasInkPair: (session.inkPairIds ?? []).includes(design.id),
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
      row: colourPlan.usesInkArtwork ? "ink" : "plain",
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

/** The enabled variant count for every plan item. */
export function planVariantCounts(plan: StudioPlan, sizes: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of plan.items) {
    counts.set(item.designId, planItemVariantIds(plan, item, sizes).length);
  }
  return counts;
}

/**
 * The API-level problems: an incomplete partition, the variant cap, or no
 * matching variants. These are the safety net; the ink artwork problems above
 * are the ones that say WHY a design cannot serve a colour.
 */
export function studioPartitionProblems(plan: StudioPlan, session: StudioSession): string[] {
  const found: string[] = [];
  for (const item of plan.items) {
    const partition = buildPartition(
      plan.colourIndex,
      item.groups.map((group) => ({ ink: group.ink, colors: group.colors })),
    );
    const issues = assertCompletePartition(
      partition.groups.map((group, index) => ({
        imageId: item.groups[index]?.assetId ?? "",
        variantIds: group.variantIds,
        colors: group.colors,
      })),
      plan.colourIndex.allVariantIds,
    );
    for (const issue of issues) found.push(`${item.designName}: ${issue.detail}`);

    const enabled = planItemVariantIds(plan, item, session.sizes);
    if (enabled.length > MAX_STUDIO_VARIANTS) {
      found.push(
        `${item.designName}: ${enabled.length} variants - Printify allows at most ${MAX_STUDIO_VARIANTS} per product.`,
      );
    }
    if (enabled.length === 0) {
      found.push(`${item.designName}: no variants match the selected colours and sizes.`);
    }
  }

  return found;
}

/**
 * Everything that stops the plan from creating products.
 *
 * The ink artwork problems come first: they name the cause ("no white-ink
 * artwork on Black and Navy") instead of only the partition symptom.
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
    ...artworkProblems.map(
      (problem) => `${problem.designName}: ${describeMissingInk(problem)}`,
    ),
    ...studioPartitionProblems(plan, session),
  ];
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
