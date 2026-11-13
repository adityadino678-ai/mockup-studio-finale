// ---------------------------------------------------------------------------
// The SHIPPED colour seed.
//
// Printify's catalogue only knows colour NAMES; the true hexes live on a
// product. This file is the seed that lets EVERY visitor paint real hexes
// with no Printify key and no shop: it carries the name -> hex pairs learned
// from real Printify products, exactly like the per-browser learned
// dictionary, but shipped with the app.
//
// Maintained by the owner (Settings -> "Copy learned colours" exports the
// browser's dictionary as JSON): paste new entries into COLOUR_SEED and the
// next build ships them. Resolution priority is unchanged - a visitor's own
// product hexes and overrides still win over the seed; the seed sits above
// the curated guesses. Every value here MUST be a real hex - a bad entry
// would mislabel an approximate colour as exact, so a guard test parses
// every value.
// ---------------------------------------------------------------------------

export const COLOUR_SEED: Record<string, string> = {};
