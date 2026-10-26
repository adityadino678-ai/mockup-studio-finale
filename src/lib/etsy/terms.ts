// ---------------------------------------------------------------------------
// Pure text helpers shared by the Etsy API research and the browser fallback.
//
// Both sources report the same observed shape: recurring title words and a
// median price. Keeping the rules here means the two paths cannot disagree
// about what a "term" is or how a median is rounded.
// ---------------------------------------------------------------------------

import type { EtsyTermCount } from "@/types/etsy";

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

/** Counts how many listings mention each term, most common first. */
export function countTerms(values: string[][], max: number): EtsyTermCount[] {
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

/** The middle value, rounded; `undefined` for an empty sample. */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}
