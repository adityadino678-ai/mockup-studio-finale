import { describe, expect, it } from "vitest";
import { verifyProductArtwork } from "@/lib/printify/verify-artwork";

/**
 * A 2-design / 4-colour pair, 2 sizes each: White + Sand print the black-ink
 * design, Black + Navy print the white-ink design.
 */
const ARTWORKS = [
  { variantIds: [1, 2, 3, 4], imageId: "img-black" },
  { variantIds: [5, 6, 7, 8], imageId: "img-white" },
];

/** The product Printify returns when the payload was correct. */
function goodProduct() {
  return {
    variants: [
      { id: 1, is_enabled: true },
      { id: 2, is_enabled: true },
      { id: 3, is_enabled: true },
      { id: 4, is_enabled: true },
      { id: 5, is_enabled: true },
      { id: 6, is_enabled: true },
      { id: 7, is_enabled: true },
      { id: 8, is_enabled: true },
      // A catalogue-invisible variant Printify adds on its own.
      { id: 99, is_enabled: false },
    ],
    print_areas: [
      {
        variant_ids: [1, 2, 3, 4],
        placeholders: [{ position: "front", images: [{ id: "img-black" }] }],
      },
      {
        variant_ids: [5, 6, 7, 8],
        placeholders: [{ position: "front", images: [{ id: "img-white" }] }],
      },
    ],
  };
}

describe("verifyProductArtwork", () => {
  it("passes a complete, correctly mapped product", () => {
    const result = verifyProductArtwork(goodProduct(), ARTWORKS);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.checked).toBe(8);
    expect(result.missingActual).toEqual([]);
    expect(result.missingExpected).toEqual([]);
    expect(result.wrongArtwork).toEqual([]);
  });

  it("ignores variants Printify added but left disabled", () => {
    const product = goodProduct();
    // The disabled variant has no image at all; it must not be reported.
    expect(product.variants.find((v) => v.id === 99)?.is_enabled).toBe(false);
    expect(verifyProductArtwork(product, ARTWORKS).ok).toBe(true);
  });

  it("reports a variant the product gave NO artwork (the old silent pass)", () => {
    const product = goodProduct();
    // Printify dropped the black-ink group entirely: every dark colour is now
    // covered by the white-ink group, so the ids disagree.
    product.print_areas = [
      {
        variant_ids: [1, 2, 3, 4, 5, 6, 7, 8],
        placeholders: [{ position: "front", images: [{ id: "img-white" }] }],
      },
    ];
    const result = verifyProductArtwork(product, ARTWORKS);
    expect(result.ok).toBe(false);
    expect(result.wrongArtwork).toEqual([1, 2, 3, 4]);
    expect(result.missingActual).toEqual([]);
  });

  it("reports a variant with no image in any print area", () => {
    const product = goodProduct();
    product.print_areas = [
      {
        variant_ids: [1, 2, 3, 4],
        placeholders: [{ position: "front", images: [{ id: "img-black" }] }],
      },
      // The white group exists but carries no image.
      { variant_ids: [5, 6, 7, 8], placeholders: [{ position: "front", images: [] }] },
    ];
    const result = verifyProductArtwork(product, ARTWORKS);
    expect(result.ok).toBe(false);
    expect(result.missingActual).toEqual([5, 6, 7, 8]);
    // The old predicate `got && want && got !== want` skipped exactly this.
    expect(result.wrongArtwork).toEqual([]);
  });

  it("reports an enabled variant we never prepared artwork for", () => {
    const product = goodProduct();
    const result = verifyProductArtwork(product, [ARTWORKS[0]]);
    expect(result.ok).toBe(false);
    expect(result.missingExpected).toEqual([5, 6, 7, 8]);
  });

  it("treats an artwork echo with no image id as missing expected artwork", () => {
    const result = verifyProductArtwork(goodProduct(), [
      { variantIds: [1, 2, 3, 4], imageId: "" },
      ARTWORKS[1],
    ]);
    expect(result.missingExpected).toEqual([1, 2, 3, 4]);
    expect(result.ok).toBe(false);
  });

  it("is not verified when the response carried no product", () => {
    for (const product of [null, undefined, {}, { variants: [] }, { print_areas: [] }]) {
      const result = verifyProductArtwork(product as never, ARTWORKS);
      expect(result.verified).toBe(false);
      expect(result.ok).toBe(false);
    }
  });

  it("is not verified when the product has no enabled variants", () => {
    const product = goodProduct();
    product.variants = product.variants.map((v) => ({ ...v, is_enabled: false }));
    const result = verifyProductArtwork(product, ARTWORKS);
    expect(result.verified).toBe(true);
    expect(result.checked).toBe(0);
    expect(result.ok).toBe(false);
  });

  it("reports the first image when two groups claim the same variant", () => {
    const product = goodProduct();
    // Overlap: the white group also claims variant 1, which should be black.
    product.print_areas = [
      { variant_ids: [5, 6, 7, 8], placeholders: [{ position: "front", images: [{ id: "img-white" }] }] },
      { variant_ids: [1, 2, 3, 4], placeholders: [{ position: "front", images: [{ id: "img-black" }] }] },
    ];
    product.print_areas[0].variant_ids = [1, 5, 6, 7, 8];
    const result = verifyProductArtwork(product, ARTWORKS);
    expect(result.wrongArtwork).toEqual([1]);
  });

  it("does not care about placeholder order or extra empty positions", () => {
    const product = goodProduct();
    product.print_areas = [
      {
        variant_ids: [1, 2, 3, 4],
        placeholders: [
          { position: "back", images: [] },
          { position: "front", images: [{ id: "img-black" }] },
        ],
      },
      {
        variant_ids: [5, 6, 7, 8],
        placeholders: [{ position: "front", images: [{ id: "img-white" }] }],
      },
    ];
    expect(verifyProductArtwork(product, ARTWORKS).ok).toBe(true);
  });

  it("passes a DESIGN PAIR product: one variant carrying a front AND a back image", () => {
    const product = goodProduct();
    // Every variant carries both sides now; the echo says so too.
    product.print_areas = [
      {
        variant_ids: [1, 2, 3, 4],
        placeholders: [
          { position: "front", images: [{ id: "img-front" }] },
          { position: "back", images: [{ id: "img-back" }] },
        ],
      },
      {
        variant_ids: [5, 6, 7, 8],
        placeholders: [
          { position: "front", images: [{ id: "img-front" }] },
          { position: "back", images: [{ id: "img-back" }] },
        ],
      },
    ];
    const echo = [
      { variantIds: [1, 2, 3, 4], imageId: "img-front" },
      { variantIds: [1, 2, 3, 4], imageId: "img-back" },
      { variantIds: [5, 6, 7, 8], imageId: "img-front" },
      { variantIds: [5, 6, 7, 8], imageId: "img-back" },
    ];
    const result = verifyProductArtwork(product, echo);
    expect(result.ok).toBe(true);
    expect(result.wrongArtwork).toEqual([]);
  });

  it("fails a design pair when one side's image is missing from the product", () => {
    const product = goodProduct();
    product.print_areas = [
      {
        variant_ids: [1, 2, 3, 4],
        placeholders: [{ position: "front", images: [{ id: "img-front" }] }],
      },
      {
        variant_ids: [5, 6, 7, 8],
        placeholders: [
          { position: "front", images: [{ id: "img-front" }] },
          { position: "back", images: [{ id: "img-back" }] },
        ],
      },
    ];
    const echo = [
      { variantIds: [1, 2, 3, 4], imageId: "img-front" },
      { variantIds: [1, 2, 3, 4], imageId: "img-back" },
      { variantIds: [5, 6, 7, 8], imageId: "img-front" },
      { variantIds: [5, 6, 7, 8], imageId: "img-back" },
    ];
    const result = verifyProductArtwork(product, echo);
    expect(result.ok).toBe(false);
    expect(result.wrongArtwork).toEqual([1, 2, 3, 4]);
  });
});
