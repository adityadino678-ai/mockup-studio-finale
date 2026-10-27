// ---------------------------------------------------------------------------
// Maps a Printify catalogue blueprint to a MockupCategory.
//
// The catalogue's category strings ("T-shirts", "Apparel", "Mugs & Bottles",
// ...) are broad and overlap. A hoodie is "Apparel", a t-shirt is "T-shirts"
// or "Apparel", a mug is "Mugs & Bottles". We match keywords in the title and
// category so the right pre-built template is chosen, checking more specific
// terms first.
// ---------------------------------------------------------------------------

import type { CatalogBlueprint } from "@/lib/printify/types";
import type { MockupCategory } from "@/types/domain";

/** Turns a catalogue blueprint into one of the six product types, or "other". */
export function mockupCategoryFor(blueprint: CatalogBlueprint): MockupCategory {
  const haystack = `${blueprint.title ?? ""} ${blueprint.category ?? ""}`.toLowerCase();

  if (/hoodie|sweatshirt|sweat.?shirt/.test(haystack)) return "hoodie";
  if (/mug|tumbler|water bottle|travel mug/.test(haystack)) return "mug";
  if (/tote|shopping bag|canvas bag/.test(haystack)) return "tote";
  if (/poster|wall art|canvas|art print|sign\b/.test(haystack)) return "poster";
  if (/sticker|label|decal/.test(haystack)) return "sticker";
  if (/t.?shirt|tee\b|t shirt/.test(haystack)) return "tshirt";
  return "other";
}
