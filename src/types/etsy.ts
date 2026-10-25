// ---------------------------------------------------------------------------
// Etsy Open API v3 research.
//
// The app is a READ-ONLY Etsy client. It uses the public keystring to search
// active listings, then reports what it observed: how many listings matched,
// which tags/title words recur, the sampled price range and a few examples.
//
// It deliberately carries no "search volume", sales, revenue or ranking data.
// Etsy's public API does not expose those, and inventing them would make the
// autopilot worse, not better.
// ---------------------------------------------------------------------------

/** One active listing used as an example. */
export interface EtsyListingSample {
  title: string;
  tags: string[];
  priceCents?: number;
  currency?: string;
  url?: string;
}

export interface EtsyTermCount {
  term: string;
  count: number;
}

/** The observed Etsy search result for one query. */
export interface EtsyResearch {
  query: string;
  searchedAt: number;
  source: "etsy-api";
  /** Etsy's `count`: every active listing matching the query. */
  activeListings: number;
  /** How many listings were actually sampled (the API limit). */
  sampled: number;
  topTags: EtsyTermCount[];
  titleTerms: EtsyTermCount[];
  medianPriceCents?: number;
  currency?: string;
  samples: EtsyListingSample[];
  /** Always says what this data is, and what it is not. */
  disclaimer: string;
}

export interface EtsyResearchResponse {
  configured: boolean;
  research?: EtsyResearch;
  error?: string;
}
