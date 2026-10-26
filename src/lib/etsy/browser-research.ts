// ---------------------------------------------------------------------------
// Etsy research from the user's own browser.
//
// The API path is preferred (it returns real tags and a total count). When no
// keystring is configured, or Etsy rejects it, the companion extension can read
// the public search page in a background tab that uses the user's own Etsy
// session. This module turns those scraped cards into the SAME `EtsyResearch`
// shape, so the agent and the copy writer do not care which path answered.
//
// What the browser CANNOT see: listing tags. Etsy's search cards expose the
// title and price, not the tags, so `topTags` is empty and the disclaimer says
// so. It never invents them.
// ---------------------------------------------------------------------------

import type { EtsyResearch } from "@/types/etsy";
import { countTerms, median, titleTerms } from "@/lib/etsy/terms";

/** One listing card as the extension scraped it. */
export interface EtsyBrowserCard {
  title: string;
  priceText?: string;
  url?: string;
}

export const ETSY_BROWSER_DISCLAIMER =
  "Read from the Etsy search page in your own browser. It shows the listings that page displayed, not search volume, sales or rankings. Search cards do not expose listing tags, so no tags are reported.";

const MAX_CARDS = 48;
const MAX_SAMPLES = 8;

const CURRENCY_MARKERS: Array<[RegExp, string]> = [
  [/\bCA\s*\$|C\$/i, "CAD"],
  [/\bAU\s*\$|A\$/i, "AUD"],
  [/\bUS\s*\$|USD/i, "USD"],
  [/\bEUR\b|€/i, "EUR"],
  [/\bGBP\b|£/i, "GBP"],
  [/\$/, "USD"],
];

/** Reads a currency from a price label without assuming the store's locale. */
function currencyOf(text: string): string | undefined {
  for (const [pattern, code] of CURRENCY_MARKERS) {
    if (pattern.test(text)) return code;
  }
  return undefined;
}

/**
 * Parses the price text Etsy puts on a search card.
 *
 * Handles `$24.99`, `US$24.99`, `€24,99`, `1.234,56 €` and `1,234.56`.
 * Returns cents only when the value is positive and finite; a malformed label
 * is dropped instead of guessing.
 */
export function parseEtsyPriceText(text: string | undefined): {
  cents?: number;
  currency?: string;
} {
  if (!text) return {};
  const clean = text.replace(/\u00a0/g, " ").trim();
  if (!clean) return {};

  const match = clean.match(/\d[\d.,\s]*/);
  if (!match) return {};
  const raw = match[0].replace(/\s/g, "").replace(/[.,]+$/, "");
  if (!raw) return {};

  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  let normalized = raw;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    normalized = raw.split(thousands).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    const after = raw.length - lastComma - 1;
    // One or two trailing digits are a decimal ("24,9", "24,99"); three are
    // thousands ("1,234"). Etsy does not show three-decimal prices.
    normalized = after <= 2 ? raw.replace(",", ".") : raw.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const after = raw.length - lastDot - 1;
    normalized = after <= 2 ? raw : raw.replace(/\./g, "");
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return {};
  const currency = currencyOf(clean);
  return {
    cents: Math.round(value * 100),
    ...(currency ? { currency } : {}),
  };
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^https:\/\/([a-z0-9-]+\.)*etsy\.com\/listing\//i.test(value) ? value : undefined;
}

/**
 * Builds the observed research shape from scraped cards.
 *
 * `activeListings` is deliberately the number of cards this page showed, not a
 * made-up total: the browser cannot see Etsy's result count. `topTags` is empty
 * because search cards do not expose tags.
 */
export function buildEtsyBrowserResearch(
  query: string,
  cards: EtsyBrowserCard[],
  searchedAt = Date.now(),
): EtsyResearch {
  const clean = cards
    .map((card) => ({
      title: String(card.title ?? "").replace(/\s+/g, " ").trim(),
      priceText: card.priceText ? String(card.priceText).trim() : undefined,
      url: safeUrl(card.url),
    }))
    .filter((card) => card.title.length > 0)
    .slice(0, MAX_CARDS);

  const prices: number[] = [];
  let currency: string | undefined;
  const samples = clean.slice(0, MAX_SAMPLES).map((card) => {
    const price = parseEtsyPriceText(card.priceText);
    if (price.cents !== undefined) prices.push(price.cents);
    if (!currency) currency = price.currency;
    return {
      title: card.title.slice(0, 140),
      tags: [] as string[],
      ...(price.cents !== undefined ? { priceCents: price.cents } : {}),
      ...(price.currency ? { currency: price.currency } : {}),
      ...(card.url ? { url: card.url } : {}),
    };
  });

  // The median is over every parsed card, not only the eight samples.
  for (const card of clean.slice(MAX_SAMPLES)) {
    const price = parseEtsyPriceText(card.priceText);
    if (price.cents !== undefined) prices.push(price.cents);
    if (!currency) currency = price.currency;
  }

  const medianPriceCents = median(prices);
  return {
    query: query.trim(),
    searchedAt,
    source: "etsy-browser",
    activeListings: clean.length,
    sampled: clean.length,
    topTags: [],
    titleTerms: countTerms(
      clean.map((card) => titleTerms(card.title)),
      25,
    ),
    ...(medianPriceCents !== undefined ? { medianPriceCents } : {}),
    ...(currency ? { currency } : {}),
    samples,
    disclaimer: ETSY_BROWSER_DISCLAIMER,
  };
}
