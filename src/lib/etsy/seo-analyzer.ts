// ---------------------------------------------------------------------------
// Etsy SEO pattern extraction.
//
// Turns one `EtsyResearch` result into the reusable patterns a listing
// template can draw on: the most frequent title terms, the most frequent tag
// frequencies, and the median price band. Pure, deterministic, and honest: it
// only reports what the research actually observed. It never invents search
// volume, sales or rankings.
// ---------------------------------------------------------------------------

import type { EtsyResearch, EtsyTermCount } from "@/types/etsy";

export interface SeoPriceBand {
  label: string;
  minCents: number;
  /** `undefined` means open-ended (no upper bound). */
  maxCents?: number;
}

export interface SeoPattern {
  source: EtsyResearch["source"];
  /** How many listings contributed to these patterns. */
  sampled: number;
  /** Title terms observed across listings, most common first. */
  topTitleTerms: EtsyTermCount[];
  /** Tag frequencies observed across listings, most common first.
   * Empty in browser mode (search cards do not expose tags). */
  topTagFrequencies: EtsyTermCount[];
  /** The band containing the median price, when a median was observed. */
  medianPriceBand: SeoPriceBand | undefined;
  currency?: string;
  medianPriceCents?: number;
}

// Price bands in cents. A listing's median price falls into exactly one.
const PRICE_BANDS: SeoPriceBand[] = [
  { label: "$0-$15", minCents: 0, maxCents: 1499 },
  { label: "$15-$25", minCents: 1500, maxCents: 2499 },
  { label: "$25-$35", minCents: 2500, maxCents: 3499 },
  { label: "$35-$50", minCents: 3500, maxCents: 4999 },
  { label: "$50+", minCents: 5000 },
];

/** The price band a cent value falls into. */
export function priceBandForCents(cents: number): SeoPriceBand {
  for (const band of PRICE_BANDS) {
    if (cents >= band.minCents && (band.maxCents === undefined || cents <= band.maxCents)) {
      return band;
    }
  }
  return PRICE_BANDS[PRICE_BANDS.length - 1];
}

/** The band containing the median price, when one was observed. */
export function medianPriceBand(research: EtsyResearch): SeoPriceBand | undefined {
  if (research.medianPriceCents === undefined) return undefined;
  return priceBandForCents(research.medianPriceCents);
}

/**
 * Extracts reusable SEO patterns from one Etsy research result.
 *
 * Browser-mode research returns no tags, so `topTagFrequencies` is empty
 * there while `topTitleTerms` still reflects the titles the browser could
 * read. The disclaimer lives on the source `research`, not here.
 */
export function analyzeSeoPatterns(research: EtsyResearch): SeoPattern {
  return {
    source: research.source,
    sampled: research.sampled,
    topTitleTerms: [...research.titleTerms],
    topTagFrequencies: [...research.topTags],
    medianPriceBand: medianPriceBand(research),
    ...(research.currency ? { currency: research.currency } : {}),
    ...(research.medianPriceCents !== undefined ? { medianPriceCents: research.medianPriceCents } : {}),
  };
}
