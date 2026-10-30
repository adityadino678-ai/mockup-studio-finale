// ---------------------------------------------------------------------------
// Verifying the product Printify actually built.
//
// `POST /api/printify/products` echoes back the image id it uploaded for each
// artwork group, and the whole created product. Comparing the two is the only
// check that proves every enabled variant carries the artwork we meant.
//
// The naive version of this check was `got && want && got !== want`, which
// short-circuits whenever the product has NO image for a variant - exactly the
// case that means the artwork went missing. A variant with no image therefore
// passed silently, so a wrong product was reported as a success.
//
// The rule here is the strict one: every enabled variant must have an expected
// image, the product must have an image for it, and the two ids must match.
// Pure: no network, no storage, no React - so it is unit-tested directly.
// ---------------------------------------------------------------------------

/** One artwork group as the create endpoint echoes it back. */
export interface EchoedArtwork {
  variantIds?: readonly number[];
  imageId?: string;
}

/** The parts of the created product this check reads. */
export interface ProductSnapshot {
  variants?: ReadonlyArray<{ id: number; is_enabled?: boolean }>;
  print_areas?: ReadonlyArray<{
    variant_ids?: readonly number[];
    placeholders?: ReadonlyArray<{
      position?: string;
      images?: ReadonlyArray<{ id?: string }>;
    }>;
  }>;
}

export interface ArtworkVerification {
  /** True only when the product was readable AND every check passed. */
  ok: boolean;
  /**
   * False when the response carried nothing we could check (no variants, or
   * no `print_areas`). Callers must treat this as a failure: "I could not
   * verify it" is not the same as "it is correct".
   */
  verified: boolean;
  /** Enabled variants we sent an image for but the product has none. */
  missingActual: number[];
  /** Enabled variants with no expected artwork at all - a construction bug. */
  missingExpected: number[];
  /** Enabled variants carrying a different image than the one we uploaded. */
  wrongArtwork: number[];
  /** How many enabled variants were checked. */
  checked: number;
}

/** The first non-empty image id attached to a variant, if any. */
function imagesByVariant(product: ProductSnapshot): Map<number, string> {
  const byVariant = new Map<number, string>();
  for (const area of product.print_areas ?? []) {
    const variantIds = area.variant_ids ?? [];
    for (const placeholder of area.placeholders ?? []) {
      for (const image of placeholder.images ?? []) {
        const id = typeof image.id === "string" ? image.id : "";
        if (!id) continue;
        for (const variantId of variantIds) {
          // First image wins, matching the order Printify reports. A variant
          // named by two groups is itself a defect; the id comparison below
          // reports it instead of hiding it.
          if (!byVariant.has(variantId)) byVariant.set(variantId, id);
        }
      }
    }
  }
  return byVariant;
}

/** What we uploaded, by variant. An artwork with no image id claims nothing. */
function expectedByVariant(artworks: readonly EchoedArtwork[]): Map<number, string> {
  const expected = new Map<number, string>();
  for (const artwork of artworks) {
    const imageId = typeof artwork.imageId === "string" ? artwork.imageId : "";
    if (!imageId) continue;
    for (const variantId of artwork.variantIds ?? []) {
      expected.set(Number(variantId), imageId);
    }
  }
  return expected;
}

/**
 * Compare the created product with the artwork the server says it uploaded.
 *
 * Only ENABLED variants matter: Printify adds variants the catalogue does not
 * expose, and those arrive disabled, so they must not be reported.
 */
export function verifyProductArtwork(
  product: ProductSnapshot | null | undefined,
  artworks: readonly EchoedArtwork[],
): ArtworkVerification {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const hasPrintAreas = Array.isArray(product?.print_areas);
  if (variants.length === 0 || !hasPrintAreas) {
    return {
      ok: false,
      verified: false,
      missingActual: [],
      missingExpected: [],
      wrongArtwork: [],
      checked: 0,
    };
  }

  const expected = expectedByVariant(artworks);
  const actual = imagesByVariant(product as ProductSnapshot);

  const missingExpected: number[] = [];
  const missingActual: number[] = [];
  const wrongArtwork: number[] = [];
  let checked = 0;

  for (const variant of variants) {
    if (variant.is_enabled === false) continue;
    checked += 1;
    const want = expected.get(variant.id);
    const got = actual.get(variant.id);
    if (!want) {
      missingExpected.push(variant.id);
      continue;
    }
    if (!got) {
      missingActual.push(variant.id);
      continue;
    }
    if (got !== want) wrongArtwork.push(variant.id);
  }

  return {
    ok:
      checked > 0 &&
      missingExpected.length === 0 &&
      missingActual.length === 0 &&
      wrongArtwork.length === 0,
    verified: true,
    missingExpected,
    missingActual,
    wrongArtwork,
    checked,
  };
}
