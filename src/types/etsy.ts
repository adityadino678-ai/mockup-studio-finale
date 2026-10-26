// ---------------------------------------------------------------------------
// Etsy research.
//
// The app is a READ-ONLY Etsy client. The preferred path uses the public
// keystring to search active listings. When no key is available, the companion
// extension can read the public search page in the user's own browser and
// returns the same shape. Both report only what they observed: titles, tags
// when available, and a sampled price range.
//
// It deliberately carries no "search volume", sales, revenue or ranking data.
// Etsy does not expose those, and inventing them would make the autopilot
// worse, not better.
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
  /** `etsy-api` is the keystring path; `etsy-browser` is the extension. */
  source: "etsy-api" | "etsy-browser";
  /**
   * The API's `count` (every matching active listing), or — in browser mode —
   * the number of cards the search page displayed. It is never a made-up total.
   */
  activeListings: number;
  /** How many listings were actually sampled. */
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
