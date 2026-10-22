// ---------------------------------------------------------------------------
// Colour -> variant resolution, and the variant partition.
//
// Two sources of truth, and they are not the same thing:
//
//   * The CATALOGUE gives colour names ("Heather Grey") and a variant id per
//     colour x size. It is what you browse with.
//   * A PRODUCT gives option VALUE ids and their real hexes, and every
//     variant lists the value ids it is made of. It is the authoritative map.
//
// Both are used here: the catalogue drives the browsing UI, and the product
// (when we have one) supplies hexes. See AGENTS.md.
//
// The partition rule is the important part. Printify REWRITES a
// `print_areas` group's `variant_ids` to swallow any variant no group named,
// and an incomplete partition makes it render the WRONG artwork on a variant.
// So the groups we build always cover every variant, and the unwanted ones
// are switched off with `is_enabled: false` instead of being left out.
// ---------------------------------------------------------------------------

import type { CatalogVariant, ColourIndex, ProductOption, ProductVariant } from "./types";

/** Builds the colour/size index from catalogue variants. */
export function buildCatalogueIndex(variants: CatalogVariant[]): ColourIndex {
  const valueIds = new Map<string, number>();
  const hexes = new Map<string, string[]>();
  const variantIds = new Map<string, number[]>();
  const sizes = new Map<string, number[]>();
  const allVariantIds: number[] = [];

  for (const v of variants) {
    allVariantIds.push(v.id);
    const colour = v.options?.color ?? v.title?.split(" / ")[0] ?? "unknown";
    const size = v.options?.size ?? v.title?.split(" / ")[1] ?? "";
    if (!variantIds.has(colour)) variantIds.set(colour, []);
    variantIds.get(colour)!.push(v.id);
    if (size) {
      if (!sizes.has(size)) sizes.set(size, []);
      sizes.get(size)!.push(v.id);
    }
  }
  return { valueIds, hexes, variantIds, sizes, allVariantIds };
}

/**
 * Builds the index from a product, which additionally carries the real hexes
 * and the authoritative option-value ids.
 */
export function buildProductIndex(options: ProductOption[], variants: ProductVariant[]): ColourIndex {
  const valueIds = new Map<string, number>();
  const hexes = new Map<string, string[]>();
  const variantIds = new Map<string, number[]>();
  const sizes = new Map<string, number[]>();
  const allVariantIds: number[] = [];

  const colourOption = options.find((o) => /colou?r/i.test(o.type ?? o.name ?? ""));
  const sizeOption = options.find((o) => /size/i.test(o.type ?? o.name ?? ""));
  for (const value of colourOption?.values ?? []) {
    valueIds.set(value.title, value.id);
    if (value.colors?.length) hexes.set(value.title, value.colors);
  }
  const colourIdToTitle = new Map<number, string>();
  for (const value of colourOption?.values ?? []) colourIdToTitle.set(value.id, value.title);
  const sizeIdToTitle = new Map<number, string>();
  for (const value of sizeOption?.values ?? []) sizeIdToTitle.set(value.id, value.title);

  for (const v of variants) {
    allVariantIds.push(v.id);
    const colourId = v.options.find((id) => colourIdToTitle.has(id));
    const sizeId = v.options.find((id) => sizeIdToTitle.has(id));
    const colour = colourId !== undefined ? colourIdToTitle.get(colourId)! : v.title;
    const size = sizeId !== undefined ? sizeIdToTitle.get(sizeId)! : "";
    if (!variantIds.has(colour)) variantIds.set(colour, []);
    variantIds.get(colour)!.push(v.id);
    if (size) {
      if (!sizes.has(size)) sizes.set(size, []);
      sizes.get(size)!.push(v.id);
    }
  }
  return { valueIds, hexes, variantIds, sizes, allVariantIds };
}

/** Every variant id for the given colours, restricted to the given sizes. */
export function resolveVariantIds(
  index: ColourIndex,
  colors: string[],
  sizes: string[],
): number[] {
  const allowedSizes = new Set(sizes);
  const out = new Set<number>();
  for (const colour of colors) {
    for (const id of index.variantIds.get(colour) ?? []) {
      if (allowedSizes.size === 0) {
        out.add(id);
        continue;
      }
      // A variant belongs to a size when the size's variant set contains it.
      const inSize = [...allowedSizes].some((s) => (index.sizes.get(s) ?? []).includes(id));
      if (inSize) out.add(id);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

/** The artwork a group is printed with. */
export type InkGroup = "main" | "black" | "white";

export interface PartitionGroup {
  /** Which ink this group prints with. "main" = the design's own artwork. */
  ink: InkGroup;
  /** The colour titles this group covers. */
  colors: string[];
  /** Every variant id in this group, after removing earlier claims. */
  variantIds: number[];
}

export interface Partition {
  groups: PartitionGroup[];
  /** Variant ids covered by exactly one group. */
  covered: number[];
  /**
   * Variant ids that no group named explicitly. The last group absorbed them,
   * which is what keeps the partition complete - but the list is kept so the
   * caller can see which variants were picked up implicitly.
   */
  unclaimed: number[];
  /** True when every variant of the product is covered exactly once. */
  complete: boolean;
}

/**
 * Builds the groups that become `print_areas`.
 *
 * `groups` is ordered: earlier groups claim their variants first, and the
 * LAST group receives everything nobody else claimed. That mirrors what
 * Printify does on its own - but doing it here means the partition we send is
 * the partition we meant, and the artwork cannot land on the wrong colour.
 *
 * Groups stay in the output even when they claim no variants, so the caller
 * can zip them with their artwork by index. An empty group is left out of the
 * payload, never the partition.
 */
export function buildPartition(
  index: ColourIndex,
  groups: Array<{ ink: InkGroup; colors: string[] }>,
): Partition {
  const claimed = new Set<number>();
  const built: PartitionGroup[] = [];

  for (const group of groups) {
    const ids: number[] = [];
    for (const colour of group.colors) {
      for (const id of index.variantIds.get(colour) ?? []) {
        if (claimed.has(id)) continue;
        claimed.add(id);
        ids.push(id);
      }
    }
    built.push({
      ink: group.ink,
      colors: [...group.colors],
      variantIds: ids.sort((a, b) => a - b),
    });
  }

  const unclaimed = index.allVariantIds.filter((id) => !claimed.has(id));
  // The absorber is the last group that actually holds variants - not simply
  // the last group, because an ink group can legitimately end up empty (for
  // example when the user marked every colour for the black ink).
  const lastWithVariants = built.filter((g) => g.variantIds.length > 0).pop();
  if (lastWithVariants && unclaimed.length > 0) {
    lastWithVariants.variantIds = [...lastWithVariants.variantIds, ...unclaimed].sort(
      (a, b) => a - b,
    );
  }

  const covered = built.flatMap((g) => g.variantIds);
  const unique = new Set(covered);
  return {
    groups: built,
    covered,
    unclaimed,
    complete: unique.size === index.allVariantIds.length && covered.length === unique.size,
  };
}

/**
 * The variants that should be enabled for a selection: the ones the user
 * picked, in the sizes they picked.
 */
export function enabledVariantIds(index: ColourIndex, colors: string[], sizes: string[]): number[] {
  return resolveVariantIds(index, colors, sizes);
}

