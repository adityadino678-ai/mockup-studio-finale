// ---------------------------------------------------------------------------
// Etsy Open API v3: read-only active-listing research.
//
// One request answers "what is already listed for this query?" from Etsy's
// public search endpoint. It is not a keyword tool: Etsy does not publish
// search volume, sales or ranking data through this API, so this module never
// pretends to have them. The autopilot uses the observed tags/terms as
// grounding for the AI copy and says where they came from.
//
// The keystring is a public read-only API key, not an OAuth token. It is
// supplied per request by the browser (`x-etsy-key`) or by the deployment
// secret (`ETSY_API_KEY`) and is never stored by the server.
// ---------------------------------------------------------------------------

import type {
  EtsyListingSample,
  EtsyResearch,
  EtsyTermCount,
} from "@/types/etsy";

const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const MAX_RESULTS = 100;
const MAX_TERMS = 25;
const MAX_SAMPLES = 8;
const REQUEST_TIMEOUT_MS = 20_000;

export const ETSY_RESEARCH_DISCLAIMER =
  "Observed from Etsy's public active-listing search. It shows active listings, not search volume, sales or rankings.";

export class EtsyApiError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "EtsyApiError";
    this.status = status;
    this.detail = detail;
  }
}

interface EtsyPrice {
  amount?: unknown;
  divisor?: unknown;
  currency_code?: unknown;
}

interface EtsyApiPayload {
  count?: unknown;
  results?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asFinite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Converts Etsy's `{amount, divisor, currency_code}` into integer cents. */
function priceInCents(price: EtsyPrice | undefined): number | undefined {
  if (!price) return undefined;
  const amount = asFinite(price.amount);
  const divisor = asFinite(price.divisor);
  if (amount === undefined || amount <= 0 || divisor === undefined || divisor <= 0) return undefined;
  return Math.max(0, Math.round((amount / divisor) * 100));
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

const STOP_WORDS = new Set([
  "a", "about", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
  "by", "can", "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for",
  "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
  "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
  "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once",
  "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own", "same", "she",
  "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up", "very", "was", "we", "were", "what", "when", "where", "which",
  "while", "who", "whom", "why", "will", "with", "you", "your", "yours", "yourself",
  "yourselves", "gift", "gifts", "perfect", "great", "best", "new", "sale",
]);

/** Title words that are worth counting, lower-cased and de-duplicated. */
export function titleTerms(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && word.length <= 30 && !STOP_WORDS.has(word));
  return [...new Set(words)];
}

function countTerms(values: string[][], max: number): EtsyTermCount[] {
  const counts = new Map<string, { term: string; count: number }>();
  for (const list of values) {
    const seen = new Set<string>();
    for (const raw of list) {
      const term = raw.trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { term, count: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, max);
}

/**
 * Turns Etsy's raw response into the app's research shape.
 *
 * Pure and defensive: Etsy can omit fields or return a listing whose price is
 * not usable, and a malformed result must not make the whole search fail.
 */
export function normaliseEtsyResearch(
  query: string,
  payload: EtsyApiPayload,
  searchedAt = Date.now(),
): EtsyResearch {
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results = rawResults
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  const tagsPerListing: string[][] = [];
  const termsPerListing: string[][] = [];
  const prices: number[] = [];
  let currency: string | undefined;

  for (const result of results) {
    const title = asString(result.title) ?? "";
    const tags = asTags(result.tags);
    tagsPerListing.push(tags);
    termsPerListing.push(titleTerms(title));

    const price = asRecord(result.price) as EtsyPrice | null;
    const cents = priceInCents(price ?? undefined);
    if (cents !== undefined) prices.push(cents);
    if (!currency) currency = asString(price?.currency_code);
  }

  const count = asFinite(payload.count);
  const activeListings =
    count !== undefined && count >= 0 ? Math.floor(count) : results.length;

  const samples: EtsyListingSample[] = results.slice(0, MAX_SAMPLES).map((result) => {
    const title = (asString(result.title) ?? "").slice(0, 140);
    const tags = asTags(result.tags).slice(0, 13);
    const price = asRecord(result.price) as EtsyPrice | null;
    const cents = priceInCents(price ?? undefined);
    const url = asString(result.url);
    return {
      title,
      tags,
      ...(cents !== undefined ? { priceCents: cents } : {}),
      ...(currency ? { currency } : {}),
      ...(url && /^https:\/\//i.test(url) ? { url } : {}),
    };
  });

  return {
    query: query.trim(),
    searchedAt,
    source: "etsy-api",
    activeListings,
    sampled: results.length,
    topTags: countTerms(tagsPerListing, MAX_TERMS),
    titleTerms: countTerms(termsPerListing, MAX_TERMS),
    ...(median(prices) !== undefined ? { medianPriceCents: median(prices) } : {}),
    ...(currency ? { currency } : {}),
    samples,
    disclaimer: ETSY_RESEARCH_DISCLAIMER,
  };
}

/** One live Etsy search, with an honest error for every failure mode. */
export async function searchEtsyActiveListings(
  apiKey: string,
  query: string,
  limit = MAX_RESULTS,
): Promise<EtsyResearch> {
  const url = new URL(`${ETSY_API_BASE}/listings/active`);
  url.searchParams.set("keywords", query.trim());
  url.searchParams.set("limit", String(Math.min(Math.max(Math.floor(limit), 1), MAX_RESULTS)));
  // Relevance first, then recency; Etsy's own score ordering.
  url.searchParams.set("sort_on", "score");
  url.searchParams.set("sort_order", "desc");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        Accept: "application/json",
        "User-Agent": "MockupStudio/0.2 (Etsy listing research)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new EtsyApiError(
      timedOut
        ? "Etsy did not answer within 20 seconds. Try again."
        : "Could not reach Etsy. Check the network and try again.",
      504,
    );
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const detail = text.slice(0, 500);
    if (response.status === 401 || response.status === 403) {
      throw new EtsyApiError(
        "Etsy rejected the keystring. Check the developer keystring in Settings, or use a different app key.",
        response.status,
        detail,
      );
    }
    if (response.status === 429) {
      throw new EtsyApiError(
        "Etsy's rate limit was reached. Wait a minute before researching again.",
        429,
        detail,
      );
    }
    if (response.status >= 500) {
      throw new EtsyApiError(
        `Etsy is temporarily unavailable (HTTP ${response.status}). Try again shortly.`,
        502,
        detail,
      );
    }
    throw new EtsyApiError(
      `Etsy rejected the search (HTTP ${response.status}). Try a shorter, simpler query.`,
      response.status,
      detail,
    );
  }

  let payload: EtsyApiPayload;
  try {
    payload = JSON.parse(text) as EtsyApiPayload;
  } catch {
    throw new EtsyApiError("Etsy returned a response this app could not read.", 502);
  }

  return normaliseEtsyResearch(query, payload);
}
