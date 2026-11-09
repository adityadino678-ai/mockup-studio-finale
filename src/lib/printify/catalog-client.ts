"use client";

// ---------------------------------------------------------------------------
// Browser-side access to the Printify catalogue.
//
// Everything goes through the app's own `/api/printify/*` endpoints, which
// attach the user's key (or the server secret) server-side. The catalogue is
// large - roughly 2900 blueprints - so it is cached in IndexedDB and searched
// locally, which is also what makes the category filter possible: the v1
// catalogue API has no category parameter of its own.
// ---------------------------------------------------------------------------

import { getSetting, setSetting } from "@/lib/db/schema";
import { authedFetch } from "@/lib/client/integrations";
import type { CatalogBlueprint, CatalogProvider, CatalogVariant } from "./types";

const BLUEPRINTS_KEY = "printifyStudio:blueprints";
const BLUEPRINTS_TTL = 24 * 60 * 60 * 1000;

/** Providers and variants are public catalogue data: a day is plenty. */
const PROVIDERS_TTL = 24 * 60 * 60 * 1000;
const VARIANTS_TTL = 24 * 60 * 60 * 1000;
/** Colour hexes come from one of the seller's own products, so they can
 * change when a template product changes. Seven days with stale-while-revalidate:
 * the cached value paints instantly and the network only refreshes in the
 * background, so a second visit makes no network call until the TTL expires. */
const COLOURS_TTL = 7 * 24 * 60 * 60 * 1000;
const LEARNED_KEY = "printifyStudio:colourLearned";
const OVERRIDES_KEY = "printifyStudio:colourOverrides";

interface Cached<T> {
  at: number;
  data: T;
}

async function readFresh<T>(key: string, ttl: number): Promise<T | null> {
  try {
    const cached = await getSetting<Cached<T> | null>(key, null);
    if (!cached || !("data" in cached) || !("at" in cached)) return null;
    if (Date.now() - cached.at > ttl) return null;
    return cached.data;
  } catch {
    return null;
  }
}

async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    await setSetting(key, { at: Date.now(), data } satisfies Cached<T>);
  } catch {
    // A catalogue cache is an optimisation; it must never fail the request.
  }
}

/** Reads a cached value of any age (stale-while-revalidate paint). */
async function readAnyAge<T>(key: string): Promise<T | null> {
  try {
    const cached = await getSetting<Cached<T> | null>(key, null);
    if (!cached || !("data" in cached)) return null;
    return cached.data;
  } catch {
    return null;
  }
}

/** Learned name->hex dictionary: every real hex ever read persists here. */
export async function loadLearnedColours(): Promise<Record<string, string>> {
  try {
    const stored = await getSetting<Record<string, string> | null>(LEARNED_KEY, null);
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

export async function mergeLearnedColours(entries: Record<string, string>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  try {
    const current = await loadLearnedColours();
    const next = { ...current, ...entries };
    await setSetting(LEARNED_KEY, next);
  } catch {
    // Optimisation only; never fail the palette.
  }
}

/** One background indexing pass over a product's hexes for many blueprints. */
export async function harvestLearnedFromSource(source: {
  colors?: Array<{ title?: string; colors?: string[] }>;
}): Promise<void> {
  const { harvestLearnedColours } = await import("./colors");
  await mergeLearnedColours(harvestLearnedColours(source.colors ?? []));
}

export async function loadColourOverrides(): Promise<Record<string, string>> {
  try {
    const stored = await getSetting<Record<string, string> | null>(OVERRIDES_KEY, null);
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

export async function saveColourOverride(name: string, hex: string): Promise<void> {
  const key = name.trim().toLowerCase();
  if (!key) return;
  const { normaliseHex } = await import("./colors");
  const current = await loadColourOverrides();
  current[key] = normaliseHex(hex);
  try {
    await setSetting(OVERRIDES_KEY, current);
  } catch {
    void 0;
  }
}

/**
 * One in-flight request per cache key. Mounting the Studio twice (or the
 * Studio plus Listing preview) used to fire the same variants call twice.
 */
const inflight = new Map<string, Promise<unknown>>();

function deduped<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

function providersKey(blueprintId: number): string {
  return `printifyStudio:providers:${blueprintId}`;
}

function variantsKey(blueprintId: number, providerId: number): string {
  return `printifyStudio:variants:${blueprintId}:${providerId}`;
}

function coloursKey(blueprintId: number, providerId: number): string {
  return `printifyStudio:colours:${blueprintId}:${providerId}`;
}

export interface CachedBlueprints {
  at: number;
  blueprints: CatalogBlueprint[];
}

export async function loadCachedBlueprints(): Promise<CatalogBlueprint[] | null> {
  const cached = await getSetting<CachedBlueprints | null>(BLUEPRINTS_KEY, null);
  if (!cached || !Array.isArray(cached.blueprints)) return null;
  return cached.blueprints;
}

export async function saveCachedBlueprints(blueprints: CatalogBlueprint[]): Promise<void> {
  // Only the fields the app uses are kept. The raw catalogue payload is
  // ~5 MB and more than half of it is the HTML `description` of every
  // product, which the app never renders - caching the whole thing cost a
  // 5 MB IndexedDB record, a 70 ms read and a 40 ms write.
  const slim = blueprints.map((b) => ({
    id: b.id,
    title: b.title,
    brand: b.brand,
    model: b.model,
    category: b.category,
    image: b.image,
    images: b.images?.slice(0, 1),
  }));
  await setSetting(BLUEPRINTS_KEY, { at: Date.now(), blueprints: slim } satisfies CachedBlueprints);
}

/** The catalogue, from cache when it is fresh enough. */
export async function fetchBlueprints(force = false): Promise<CatalogBlueprint[]> {
  if (!force) {
    const cached = await getSetting<CachedBlueprints | null>(BLUEPRINTS_KEY, null);
    if (cached && Date.now() - cached.at < BLUEPRINTS_TTL && cached.blueprints.length > 0) {
      return cached.blueprints;
    }
  }
  const res = await authedFetch("/api/printify/catalog");
  const data = await res.json();
  if (!res.ok || !Array.isArray(data.blueprints)) {
    throw new Error(data.error ?? `Could not load the Printify catalogue (HTTP ${res.status})`);
  }
  await saveCachedBlueprints(data.blueprints);
  return data.blueprints;
}

export async function fetchProviders(blueprintId: number, force = false): Promise<CatalogProvider[]> {
  if (!force) {
    const cached = await readFresh<CatalogProvider[]>(providersKey(blueprintId), PROVIDERS_TTL);
    if (cached) return cached;
  }
  return deduped(`providers:${blueprintId}`, async () => {
    const res = await authedFetch(`/api/printify/catalog?id=${blueprintId}&providers=1`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not load print providers");
    const providers = Array.isArray(data.providers) ? data.providers : [];
    await writeCache(providersKey(blueprintId), providers);
    return providers;
  });
}

export async function fetchVariants(
  blueprintId: number,
  providerId: number,
  force = false,
): Promise<CatalogVariant[]> {
  if (!force) {
    const cached = await readFresh<CatalogVariant[]>(variantsKey(blueprintId, providerId), VARIANTS_TTL);
    if (cached) return cached;
  }
  return deduped(`variants:${blueprintId}:${providerId}`, async () => {
    const res = await authedFetch(`/api/printify/catalog?id=${blueprintId}&provider=${providerId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not load variants");
    const variants = Array.isArray(data.variants) ? data.variants : [];
    await writeCache(variantsKey(blueprintId, providerId), variants);
    return variants;
  });
}

export interface ColourValue {
  id: number;
  title: string;
  colors: string[];
}

export interface SizeValue {
  id: number;
  title: string;
}

export interface ProductVariantRow {
  id: number;
  title: string;
  options: number[];
}

export interface ColourSource {
  /** "product" when real hexes were found, "none" when they were not. */
  source: "product" | "none";
  /** True when the hexes came from the same blueprint but another provider. */
  approximate?: boolean;
  templateProductId?: string;
  colors: ColourValue[];
  sizes: SizeValue[];
  variants: ProductVariantRow[];
}

/** Any-age cached colour source for instant stale-while-revalidate paint. */
export async function loadCachedColourSource(
  blueprintId: number,
  providerId: number,
): Promise<ColourSource | null> {
  return readAnyAge<ColourSource>(coloursKey(blueprintId, providerId));
}

/**
 * The real colour hexes for a blueprint + provider.
 *
 * Printify's catalogue only knows colour NAMES. The hexes live on a product,
 * so we look for one the seller already made for the same blueprint and
 * provider. When there is none, the caller falls back to the curated table.
 *
 * This is three Printify round trips (shops, product list, product detail), so
 * it is cached per blueprint + provider for 7 days and must never block the
 * colour names: the palette renders from the variants first and swaps in the
 * real hexes when this resolves. Every real hex is also harvested into the
 * learned dictionary so one indexing pass serves many blueprints.
 */
export async function fetchColourSource(
  blueprintId: number,
  providerId: number,
  force = false,
): Promise<ColourSource> {
  if (!force) {
    const cached = await readFresh<ColourSource>(coloursKey(blueprintId, providerId), COLOURS_TTL);
    if (cached) return cached;
  }
  return deduped(`colours:${blueprintId}:${providerId}`, async () => {
    const res = await authedFetch(
      `/api/printify/catalog?id=${blueprintId}&provider=${providerId}&colors=1`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not read the product colours");
    const source: ColourSource = {
      source: data.source ?? "none",
      approximate: data.approximate === true,
      templateProductId: data.templateProductId,
      colors: Array.isArray(data.colors) ? data.colors : [],
      sizes: Array.isArray(data.sizes) ? data.sizes : [],
      variants: Array.isArray(data.variants) ? data.variants : [],
    };
    await writeCache(coloursKey(blueprintId, providerId), source);
    if (source.source === "product" && source.colors.length > 0) {
      // Background harvest: one product teaches many blueprints.
      void harvestLearnedFromSource(source).catch(() => undefined);
    }
    return source;
  });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Printify's v1 catalogue has no category parameter, so the categories are
 * derived from the product titles. It is a keyword map, not an official
 * taxonomy - but it is what makes the catalogue browsable.
 */
const CATEGORY_RULES: Array<{ category: string; patterns: RegExp[] }> = [
  { category: "T-Shirts", patterns: [/t-?shirt/, /\btee\b/, /t-shirt/] },
  { category: "Hoodies & Sweatshirts", patterns: [/hoodie/, /sweatshirt/, /crewneck.*sweat/] },
  { category: "Long Sleeve", patterns: [/long sleeve/, /long-sleeve/] },
  { category: "Tank Tops", patterns: [/tank/, /sleeveless/, /vest/] },
  { category: "Polos", patterns: [/polo/] },
  { category: "Outerwear", patterns: [/jacket/, /vest\b/, /coat/, /windbreaker/, /parka/] },
  { category: "Kids & Baby", patterns: [/kids/, /child/, /infant/, /baby/, /toddler/] },
  { category: "Activewear", patterns: [/legging/, /sports bra/, /shorts/, /jogger/] },
  { category: "Mugs & Bottles", patterns: [/mug/, /tumbler/, /bottle/, /water bottle/, /travel mug/] },
  { category: "Drinkware", patterns: [/glass/, /can cooler/, /can\b.*holder/] },
  { category: "Home Decor", patterns: [/poster/, /wall art/, /canvas/, /print/, /sign/, /plaque/, /ornament/] },
  { category: "Blankets & Bedding", patterns: [/blanket/, /throw/, /duvet/, /pillow/, /sheet/] },
  { category: "Home & Living", patterns: [/cushion/, /mat\b/, /rug/, /towel/] },
  { category: "Accessories", patterns: [/hat\b/, /cap\b/, /beanie/, /tote/, /bag\b/, /backpack/, /pouch/] },
  { category: "Phone & Tech", patterns: [/phone case/, /phone/, /laptop/, /tablet/, /tech/, /gadget/] },
  { category: "Stickers & Labels", patterns: [/sticker/, /label/, /decal/] },
  { category: "Stationery", patterns: [/notebook/, /journal/, /planner/, /notepad/, /binder/] },
  { category: "Apparel", patterns: [/apparel/, /shirt/, /hoodie/, /sweat/] },
  { category: "Sports & Outdoors", patterns: [/sports?/, /outdoor/, /camping/, /fishing/, /golf/] },
  { category: "Gaming", patterns: [/game/, /gamer/, /console/] },
  { category: "Pets", patterns: [/pet/, /dog/, /cat\b/] },
];

/** The category a blueprint title falls into, or "Other". */
export function categoryFor(blueprint: CatalogBlueprint): string {
  const haystack = `${blueprint.title ?? ""} ${(blueprint as { description?: string }).description ?? ""}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) return rule.category;
  }
  return "Other";
}

/** One catalogue entry with its search fields worked out in advance. */
export interface BlueprintEntry {
  blueprint: CatalogBlueprint;
  /** Lower-cased title + brand + model, for matching. */
  haystack: string;
  category: string;
}

/**
 * Works out the search fields for the whole catalogue once.
 *
 * The catalogue has ~2,900 entries and the category rules run up to 22
 * regexes each, so doing that work on every keystroke cost 30-60 ms and
 * dropped frames. The index does it once per catalogue load.
 */
export function buildBlueprintIndex(blueprints: CatalogBlueprint[]): BlueprintEntry[] {
  return blueprints.map((blueprint) => ({
    blueprint,
    haystack: `${blueprint.title ?? ""} ${blueprint.brand ?? ""} ${blueprint.model ?? ""}`.toLowerCase(),
    category: categoryFor(blueprint),
  }));
}

/** Every category present in the index, with how many products each has. */
export function categoriesOfIndex(index: BlueprintEntry[]): Array<{ category: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of index) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Filters the catalogue index by a search string and a category. */
export function filterBlueprintIndex(
  index: BlueprintEntry[],
  query: string,
  category: string | null,
): BlueprintEntry[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return index.filter((entry) => {
    if (category && category !== "All" && entry.category !== category) return false;
    if (tokens.length === 0) return true;
    return tokens.every((t) => entry.haystack.includes(t));
  });
}

/** Every category present in the catalogue, with how many products each has. */
export function categoriesOf(blueprints: CatalogBlueprint[]): Array<{ category: string; count: number }> {
  return categoriesOfIndex(buildBlueprintIndex(blueprints));
}

/** Filters the catalogue by a search string and a category. */
export function filterBlueprints(
  blueprints: CatalogBlueprint[],
  query: string,
  category: string | null,
): CatalogBlueprint[] {
  return filterBlueprintIndex(buildBlueprintIndex(blueprints), query, category).map((e) => e.blueprint);
}
