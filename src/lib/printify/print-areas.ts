// ---------------------------------------------------------------------------
// Building the Printify `print_areas` payload.
//
// A product's artwork is described as groups: each group names the variants it
// applies to and carries its own image. Two rules from the live API drive
// this module:
//
//   1. `print_areas` is REQUIRED. A create without it fails with code 8150.
//   2. The groups must cover every variant. Printify rewrites a group's
//      `variant_ids` to swallow anything nobody named, and a variant that
//      ends up in the wrong group is rendered with the wrong artwork.
//
// `assertCompletePartition` is the guard for (2). Call it before sending.
// ---------------------------------------------------------------------------

import type { PrintAreaGroup, PrintAreaImage } from "./types";
import { clampPlacement } from "./fit";
import type { StudioPlacement } from "@/types/domain";

export type { StudioPlacement };

/** The default placement: centred, filling the print area. */
export const DEFAULT_PLACEMENT: StudioPlacement = {
  position: "front",
  x: 0.5,
  y: 0.5,
  scale: 1,
  angle: 0,
};

/** One artwork group: which variants it covers, and the image it uses. */
export interface ArtworkGroup {
  /** The uploaded Printify image id. */
  imageId: string;
  /** The variants this artwork is printed on. */
  variantIds: number[];
  /** The colour titles this group covers (used for diagnostics). */
  colors?: string[];
}

export interface BuildPrintAreasInput {
  groups: ArtworkGroup[];
  placement: StudioPlacement;
}

/**
 * Turns artwork groups into the `print_areas` payload.
 *
 * Groups with no variants are dropped: Printify rejects an empty group, and
 * an empty group carries no meaning.
 */
export function buildPrintAreas(input: BuildPrintAreasInput): PrintAreaGroup[] {
  const { position } = input.placement;
  const p = clampPlacement(input.placement);
  const image: PrintAreaImage = {
    id: "",
    x: p.x,
    y: p.y,
    scale: p.scale,
    angle: p.angle,
  };
  return input.groups
    .filter((g) => g.variantIds.length > 0 && g.imageId)
    .map((g) => ({
      variant_ids: [...g.variantIds].sort((a, b) => a - b),
      placeholders: [{ position, images: [{ ...image, id: g.imageId }] }],
    }));
}

export interface PartitionProblem {
  kind: "missing" | "duplicate" | "empty-group" | "unknown";
  detail: string;
  variantIds?: number[];
}

/**
 * Checks that the groups form a complete partition of the variant set.
 *
 * Returns every problem found; an empty array means the payload is safe to
 * send. The client refuses to create a product while this reports anything.
 *
 * A group that claims no variants is only a problem when it was given
 * colours - an ink group with no colours assigned is a normal state (the
 * user marked every colour for the other ink).
 */
export function assertCompletePartition(
  groups: ArtworkGroup[],
  allVariantIds: number[],
): PartitionProblem[] {
  const problems: PartitionProblem[] = [];
  const seen = new Map<number, number>();
  const known = new Set(allVariantIds);

  groups.forEach((group, index) => {
    if (group.variantIds.length === 0 && (group.colors?.length ?? 0) > 0) {
      problems.push({
        kind: "empty-group",
        detail: `group ${index} has colours but no variants (the print provider may not offer them)`,
      });
    }
    for (const id of group.variantIds) {
      const previous = seen.get(id);
      if (previous !== undefined) {
        problems.push({
          kind: "duplicate",
          detail: `variant ${id} is in group ${previous} and group ${index}`,
          variantIds: [id],
        });
      } else {
        seen.set(id, index);
      }
    }
  });

  const missing = allVariantIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    problems.push({
      kind: "missing",
      detail: `${missing.length} variant(s) are not in any group`,
      variantIds: missing,
    });
  }
  const unknown = [...seen.keys()].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    problems.push({
      kind: "unknown",
      detail: `${unknown.length} variant id(s) do not belong to this product`,
      variantIds: unknown,
    });
  }
  return problems;
}

/** A human-readable summary of the partition problems, for the UI. */
export function describePartitionProblems(problems: PartitionProblem[]): string {
  if (problems.length === 0) return "";
  return problems
    .map((p) => p.detail)
    .join("; ");
}
