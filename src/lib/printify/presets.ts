// ---------------------------------------------------------------------------
// Print area presets.
//
// The fallback for a user with no Printify key: the areas that are actually
// used most, with the sizes Printify publishes for them. The catalogue is
// always the authority - these are a convenience, and the UI says so.
//
// A preset is only ever a starting point: the user can type any width and
// height, and a mockup's area can always be pointed at a real catalogue
// placeholder later.
// ---------------------------------------------------------------------------

export interface PrintAreaPreset {
  id: string;
  label: string;
  /** The area's pixel size, as Printify publishes it. */
  width: number;
  height: number;
  /** The position this area normally sits at. */
  position: string;
}

/**
 * The common Printify areas.
 *
 * The DTG fronts are 4500 x 5400 for most tees; hoodies are taller because
 * the print area follows the garment; embroidery is square and much smaller
 * because it is stitched, not printed.
 */
export const PRINT_AREA_PRESETS: PrintAreaPreset[] = [
  { id: "tee-dtg-front", label: "Tee · DTG front", width: 4500, height: 5400, position: "front" },
  { id: "tee-dtg-back", label: "Tee · DTG back", width: 4500, height: 5400, position: "back" },
  { id: "hoodie-dtg-front", label: "Hoodie · DTG front", width: 4500, height: 6000, position: "front" },
  { id: "tote-dtg-front", label: "Tote · DTG front", width: 4500, height: 4500, position: "front" },
  { id: "mug-wrap", label: "Mug · wrap", width: 2475, height: 2475, position: "front" },
  { id: "embroidery-front", label: "Embroidery · square", width: 2000, height: 2000, position: "front" },
];

/** A preset by id. */
export function findPrintAreaPreset(id: string): PrintAreaPreset | undefined {
  return PRINT_AREA_PRESETS.find((p) => p.id === id);
}
