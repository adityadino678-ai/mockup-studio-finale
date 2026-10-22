// ---------------------------------------------------------------------------
// The mockup categories, and their labels.
//
// The category is what the mockup IS (a T-shirt, a hoodie, a mug...). It is
// already known from the Mockups tab, so the print area's typical sizes
// follow from it - the user never has to name the type again.
// ---------------------------------------------------------------------------

import type { MockupCategory } from "@/types/domain";

export const CATEGORY_LABELS: Record<MockupCategory, string> = {
  tshirt: "T-shirts",
  hoodie: "Hoodies",
  mug: "Mugs",
  poster: "Posters",
  tote: "Tote bags",
  sticker: "Stickers",
  other: "Other",
};

/** One mockup's category, in the singular. */
export const CATEGORY_SINGULAR: Record<MockupCategory, string> = {
  tshirt: "T-shirt",
  hoodie: "hoodie",
  mug: "mug",
  poster: "poster",
  tote: "tote bag",
  sticker: "sticker",
  other: "item",
};
