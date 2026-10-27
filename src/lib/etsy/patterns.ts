// ---------------------------------------------------------------------------
// Distinct randomised listing-variation patterns.
//
// Given an `SeoPattern` (from `seo-analyzer.ts`) and a listing count, produces
// one variation per listing. No two listings receive identical copy: each
// listing gets a different seeded draw from the observed title terms and tag
// frequencies, and identical candidates are re-rolled. Output is deterministic
// for a fixed seed, so the same run always suggests the same copy.
// ---------------------------------------------------------------------------

import type { SeoPattern } from "@/lib/etsy/seo-analyzer";

const DEFAULT_TITLE_MAX = 140; // Etsy's title limit
const DEFAULT_TAG_MAX = 20; // Etsy's per-tag limit
const DEFAULT_MAX_TAGS = 13; // Etsy's tag cap
const MAX_RE_ROLLS = 12;

/** One suggested listing's SEO copy: title, tags and an optional price. */
export interface ListingVariation {
  title: string;
  tags: string[];
  priceCents?: number;
}

export interface MakeVariationsOptions {
  /** Seed for the randomised draw; fixed per autopilot run keeps results stable. */
  seed?: number;
  /** Price in cents applied to every variation (defaults to the pattern's median). */
  priceCents?: number;
  titleMaxLength?: number;
  tagMaxLength?: number;
  maxTags?: number;
}

/** xorshift32-style seeded PRNG (mulberry32). Returns [0, 1). */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks `count` distinct items from `pool` using `rng`, preserving first-seen order. */
function pickDistinct<T>(rng: () => number, pool: T[], count: number): T[] {
  if (pool.length === 0 || count <= 0) return [];
  const take = Math.min(count, pool.length);
  const picked: T[] = [];
  const used = new Set<number>();
  for (let k = 0; k < take; k++) {
    let pos = Math.floor(rng() * pool.length);
    let tries = 0;
    while (used.has(pos) && tries < pool.length) {
      pos = (pos + 1) % pool.length;
      tries += 1;
    }
    used.add(pos);
    picked.push(pool[pos]);
  }
  return picked;
}

function buildTitle(rng: () => number, terms: string[], index: number, maxLength: number): string {
  if (terms.length === 0) return `Listing ${index + 1}`;
  const pickCount = 1 + Math.floor(rng() * Math.min(3, terms.length));
  const chosen = pickDistinct(rng, terms, pickCount);
  let title = chosen.join(" ");
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title.slice(0, maxLength);
}

function buildTags(
  rng: () => number,
  tags: string[],
  terms: string[],
  maxTags: number,
  tagMaxLength: number,
): string[] {
  const pool: string[] = [];
  const seen = new Set<string>();
  const add = (tag: string) => {
    const key = tag.toLowerCase();
    if (tag.length === 0 || tag.length > tagMaxLength || seen.has(key)) return;
    seen.add(key);
    pool.push(tag);
  };
  for (const tag of tags) add(tag);
  for (const term of terms) add(term);

  const picked = pickDistinct(rng, pool, 1 + Math.floor(rng() * Math.min(maxTags, pool.length)));
  return picked;
}

function buildVariation(
  rng: () => number,
  terms: string[],
  tags: string[],
  price: number | undefined,
  options: { titleMaxLength: number; tagMaxLength: number; maxTags: number; index: number },
): ListingVariation {
  const title = buildTitle(rng, terms, options.index, options.titleMaxLength);
  const listingTags = buildTags(rng, tags, terms, options.maxTags, options.tagMaxLength);
  return {
    title,
    tags: listingTags,
    ...(price !== undefined ? { priceCents: price } : {}),
  };
}

/**
 * Produces `count` distinct randomised listing variations from one SEO pattern.
 *
 * Each listing is seeded independently (`seed + index`), so the same run
 * suggests different copy for each listing while staying reproducible.
 * Identical (title, tags) pairs are re-rolled; a final index suffix guarantees
 * distinctness even in degenerate pools.
 */
export function makeListingVariations(
  pattern: SeoPattern,
  count: number,
  options: MakeVariationsOptions = {},
): ListingVariation[] {
  const {
    seed = 0,
    priceCents: forcedPrice,
    titleMaxLength = DEFAULT_TITLE_MAX,
    tagMaxLength = DEFAULT_TAG_MAX,
    maxTags = DEFAULT_MAX_TAGS,
  } = options;

  const terms = pattern.topTitleTerms.map((entry) => entry.term);
  const tags = pattern.topTagFrequencies.map((entry) => entry.term);
  const price = forcedPrice ?? pattern.medianPriceCents;

  const variations: ListingVariation[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < count; i++) {
    let variation: ListingVariation | null = null;
    for (let attempt = 0; attempt < MAX_RE_ROLLS; attempt++) {
      const candidate = buildVariation(
        mulberry32((seed + i + attempt * 97) | 0),
        terms,
        tags,
        price,
        { titleMaxLength, tagMaxLength, maxTags, index: i },
      );
      const key = `${candidate.title.toLowerCase()}::${candidate.tags.join(",")}`;
      if (!seen.has(key)) {
        seen.add(key);
        variation = candidate;
        break;
      }
    }

    if (!variation) {
      // Degenerate pool: force distinctness with the listing index.
      variation = buildVariation(
        mulberry32((seed + count + i) | 0),
        terms,
        tags,
        price,
        { titleMaxLength, tagMaxLength, maxTags, index: i },
      );
      variation.title = `${variation.title} #${i + 1}`.slice(0, titleMaxLength);
    }

    variations.push(variation);
  }

  return variations;
}
