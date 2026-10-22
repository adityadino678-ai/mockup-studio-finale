// ---------------------------------------------------------------------------
// Print area presets.
//
// The fallback for when the Printify Studio has no product selected, or when
// the user wants a typical size for the mockup's category instead of the
// exact one. The mockup's CATEGORY (T-shirt, hoodie, mug...) is already known
// from the Mockups tab, so the list of sensible sizes follows from it.
//
// These are typical sizes, not a guarantee: the catalogue is the authority,
// and the Studio's product supplies the exact area when there is one.
// ---------------------------------------------------------------------------

import type { MockupCategory } from "@/types/domain";

export interface PrintAreaPreset {
  id: string;
  label: string;
  /** The area's pixel size, as Printify publishes it. */
  width: number;
  height: number;
  /** The mockup categories this size makes sense for. */
  categories: MockupCategory[];
}

/**
 * The common Printify areas.
 *
 * The DTG fronts are 4500 x 5400 for most tees; hoodies are taller because
 * the print area follows the garment; embroidery is square and much smaller
 * because it is stitched, not printed.
 */
export const PRINT_AREA_PRESETS: PrintAreaPreset[] = [
  {
    id: "tee-dtg-front",
    label: "Tee · DTG front",
    width: 4500,
    height: 5400,
    categories: ["tshirt"],
  },
  {
    id: "tee-dtg-back",
    label: "Tee · DTG back",
    width: 4500,
    height: 5400,
    categories: ["tshirt"],
  },
  {
    id: "hoodie-dtg-front",
    label: "Hoodie · DTG front",
    width: 4500,
    height: 6000,
    categories: ["hoodie"],
  },
  {
    id: "tote-dtg-front",
    label: "Tote · DTG front",
    width: 4500,
    height: 4500,
    categories: ["tote"],
  },
  {
    id: "mug-wrap",
    label: "Mug · wrap",
    width: 2475,
    height: 2475,
    categories: ["mug"],
  },
  {
    id: "poster-18x24",
    label: "Poster · 18 × 24 in",
    width: 4500,
    height: 6000,
    categories: ["poster"],
  },
  {
    id: "sticker-sheet",
    label: "Sticker · sheet",
    width: 2000,
    height: 2000,
    categories: ["sticker"],
  },
];

/** A preset by id. */
export function findPrintAreaPreset(id: string): PrintAreaPreset | undefined {
  return PRINT_AREA_PRESETS.find((p) => p.id === id);
}

/**
 * The presets that make sense for a mockup's category.
 *
 * A category with no preset of its own (or "other") gets nothing: the user
 * types a custom size instead.
 */
export function presetsForCategory(category: MockupCategory): PrintAreaPreset[] {
  return PRINT_AREA_PRESETS.filter((p) => p.categories.includes(category));
}
