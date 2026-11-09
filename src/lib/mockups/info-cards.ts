// ---------------------------------------------------------------------------
// Info cards.
//
// An info card is a fixed information image - a size chart, a "what you get"
// panel, a care-instructions graphic. It is NOT a product photo: it never
// becomes a Printify mockup and it never takes part in the drag order. It
// simply follows the product mockups on the listing.
//
// The cards live in the SAME `mockups` table as the product photos, so they
// get the same library UI, but every product surface filters them out with
// `isProductMockup`. Nothing here needs a Dexie migration: `kind` and
// `subCategory` are optional fields, so an existing row keeps its meaning.
// ---------------------------------------------------------------------------

import type { Mockup, MockupCategory } from "@/types/domain";
import { CATEGORY_LABELS } from "@/lib/mockups/categories";

/** The sub-category every mockup starts in. */
export const DEFAULT_SUBCATEGORY = "Default";

/** True for an info card. */
export function isInfoCard(mockup: Mockup): boolean {
  return mockup.kind === "info-card";
}

/** True for a product photo - the only kind that is draggable and sent. */
export function isProductMockup(mockup: Mockup): boolean {
  return mockup.kind !== "info-card";
}

/** The product photos, in library order. */
export function productMockups(mockups: Mockup[]): Mockup[] {
  return mockups.filter(isProductMockup);
}

/** The info cards, in their own order. */
export function infoCardMockups(mockups: Mockup[]): Mockup[] {
  return mockups
    .filter(isInfoCard)
    .sort(
      (a, b) =>
        (a.infoCardOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.infoCardOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt - b.createdAt,
    );
}

/**
 * The info cards that attach to ONE listing.
 *
 * Cards attach by the category of the PRODUCT MOCKUPS included in that
 * listing's selection - not the Printify catalogue, so the strip works with
 * no API key at all. A mixed-category selection attaches the union of the
 * categories' cards. `includedIds` is the listing's effective (global) order.
 */
export function infoCardsForListing(
  mockups: Mockup[],
  includedIds: string[],
): Mockup[] {
  const included = new Set(includedIds);
  const categories = new Set<MockupCategory>();
  for (const mockup of mockups) {
    if (isInfoCard(mockup)) continue;
    if (included.has(mockup.id)) categories.add(mockup.category);
  }
  if (categories.size === 0) return [];
  return infoCardMockups(mockups).filter((mockup) => categories.has(mockup.category));
}

/**
 * The info cards that belong to one main category.
 *
 * A listing attaches the cards of ITS category automatically - there is no
 * toggle, because the whole point of an info card is that it describes the
 * product it sits next to.
 */
export function infoCardsForCategory(
  mockups: Mockup[],
  category: MockupCategory | undefined,
): Mockup[] {
  if (!category) return [];
  return infoCardMockups(mockups).filter((mockup) => mockup.category === category);
}

/**
 * The mockup category a product belongs to.
 *
 * The catalogue has its own category names ("T-Shirts", "Mugs & Bottles"),
 * and the mockup library has its own ("tshirt", "mug"). The product TITLE is
 * the reliable link between them, so it is matched on the words a shop would
 * actually use.
 */
export function mockupCategoryForTitle(title: string | undefined): MockupCategory | undefined {
  if (!title) return undefined;
  const haystack = title.toLowerCase();
  const rules: Array<[MockupCategory, RegExp[]]> = [
    ["sticker", [/sticker/, /label/, /decal/]],
    ["mug", [/mug/, /tumbler/, /\bcup\b/, /bottle/]],
    ["tote", [/tote/, /\bbag\b/, /backpack/, /pouch/]],
    ["poster", [/poster/, /wall art/, /canvas/, /\bprint\b/, /sign\b/, /plaque/]],
    ["hoodie", [/hoodie/, /sweatshirt/, /crewneck/, /jacket/, /vest\b/, /sweater/]],
    ["tshirt", [/t-?shirt/, /\btee\b/, /long sleeve/, /tank/, /polo/, /shirt/, /top\b/]],
  ];
  for (const [category, patterns] of rules) {
    if (patterns.some((pattern) => pattern.test(haystack))) return category;
  }
  return undefined;
}

/** The label a category shows in the UI. */
export function categoryLabel(category: MockupCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * The sub-categories that exist inside one main category.
 *
 * A sub-category is a user-created named template - "Hanging", "Front flat",
 * "Lifestyle". They are per main category, so the same name can mean
 * different things under different categories without colliding.
 */
export function subCategoriesFor(
  mockups: Mockup[],
  category: MockupCategory,
  kind?: "product" | "info-card",
): string[] {
  const names = new Set<string>();
  for (const mockup of mockups) {
    if (mockup.category !== category) continue;
    if (kind && (mockup.kind ?? "product") !== kind) continue;
    names.add(mockup.subCategory ?? DEFAULT_SUBCATEGORY);
  }
  return [...names].sort((a, b) => {
    if (a === DEFAULT_SUBCATEGORY) return -1;
    if (b === DEFAULT_SUBCATEGORY) return 1;
    return a.localeCompare(b);
  });
}

/** The sub-category a mockup is in. */
export function subCategoryOf(mockup: Mockup): string {
  return mockup.subCategory ?? DEFAULT_SUBCATEGORY;
}
