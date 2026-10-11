import { describe, expect, it } from "vitest";
import { validateListing, ETSY_TAG_MAX_COUNT, ETSY_TAG_MAX_LENGTH, ETSY_TITLE_MAX } from "@/lib/listings/validation";

describe("Etsy listing validation", () => {
  const valid = {
    title: "Retro Hiking T-Shirt, Mountain Lover Gift",
    description: "A soft cotton shirt with a printed design. Ships in 3 days.",
    tags: Array.from({ length: ETSY_TAG_MAX_COUNT }, (_, i) => `tag${i}`),
    priceCents: 2499,
    quantity: 10,
  };

  it("accepts a compliant listing", () => {
    const result = validateListing(valid);
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it("requires a title and description", () => {
    const result = validateListing({ title: "  ", description: "", tags: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Title is required/);
    expect(result.errors.join(" ")).toMatch(/Description is required/);
  });

  it("enforces the title length limit", () => {
    const result = validateListing({ ...valid, title: "x".repeat(ETSY_TITLE_MAX + 1) });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(new RegExp(`${ETSY_TITLE_MAX} characters`));
  });

  it("enforces the tag count and length limits", () => {
    const tooMany = validateListing({
      ...valid,
      tags: Array.from({ length: ETSY_TAG_MAX_COUNT + 1 }, (_, i) => `tag${i}`),
    });
    expect(tooMany.valid).toBe(false);
    expect(tooMany.errors.join(" ")).toMatch(new RegExp(`at most ${ETSY_TAG_MAX_COUNT} tags`));

    const tooLong = validateListing({ ...valid, tags: ["x".repeat(ETSY_TAG_MAX_LENGTH + 1)] });
    expect(tooLong.valid).toBe(false);
    expect(tooLong.errors.join(" ")).toMatch(new RegExp(`${ETSY_TAG_MAX_LENGTH} characters`));
  });

  it("warns (not errors) on weak tag coverage and title/tag mismatch", () => {
    const result = validateListing({
      title: "Retro Hiking T-Shirt",
      description: "Soft shirt",
      tags: ["hiking shirt", "mountain lover"],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects prices below one dollar", () => {
    const result = validateListing({ ...valid, priceCents: 99 });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/\$1\.00/);
  });
});