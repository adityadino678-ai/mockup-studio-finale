// Etsy listing constraints (from Etsy's Open API v3 listing endpoints).
// Validation lives here so both the UI and any future API submission share one
// source of truth. Title max is 140 characters; up to 13 tags of 20 characters.

export const ETSY_TITLE_MAX = 140;
export const ETSY_TAG_MAX_COUNT = 13;
export const ETSY_TAG_MAX_LENGTH = 20;
export const ETSY_DESCRIPTION_MAX = 10_000;

export interface ListingValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateListing(input: {
  title: string;
  description: string;
  tags: string[];
  priceCents?: number;
  quantity?: number;
}): ListingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const title = input.title.trim();
  if (title.length === 0) errors.push("Title is required");
  else if (title.length > ETSY_TITLE_MAX)
    errors.push(`Title must be ${ETSY_TITLE_MAX} characters or fewer (currently ${title.length})`);

  if (input.description.trim().length === 0) errors.push("Description is required");
  else if (input.description.length > ETSY_DESCRIPTION_MAX)
    errors.push(`Description must be ${ETSY_DESCRIPTION_MAX.toLocaleString()} characters or fewer`);

  const tags = input.tags.map((t) => t.trim()).filter(Boolean);
  if (tags.length > ETSY_TAG_MAX_COUNT)
    errors.push(`Etsy allows at most ${ETSY_TAG_MAX_COUNT} tags (currently ${tags.length})`);
  const tooLong = tags.filter((t) => t.length > ETSY_TAG_MAX_LENGTH);
  if (tooLong.length > 0)
    errors.push(
      `Tags must be ${ETSY_TAG_MAX_LENGTH} characters or fewer: ${tooLong.map((t) => `"${t}"`).join(", ")}`,
    );
  if (tags.length < 5) warnings.push(`Etsy works best with ${ETSY_TAG_MAX_COUNT} tags — add ${ETSY_TAG_MAX_COUNT - tags.length} more`);
  if (tags.length > 0 && title.length > 0) {
    const unused = tags.filter((t) => !title.toLowerCase().includes(t.toLowerCase()));
    if (unused.length > 0)
      warnings.push(`${unused.length} tag(s) do not appear in the title — Etsy rewards title/tag match`);
  }

  if (input.priceCents != null) {
    if (input.priceCents < 100) errors.push("Price must be at least $1.00");
    if (input.priceCents > 10_000_00) warnings.push("Price is above $10,000 — check this is intended");
  }
  if (input.quantity != null && (input.quantity < 1 || !Number.isFinite(input.quantity)))
    errors.push("Quantity must be at least 1");

  return { valid: errors.length === 0, errors, warnings };
}