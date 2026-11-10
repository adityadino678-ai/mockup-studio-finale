"use client";

// ---------------------------------------------------------------------------
// The studio session.
//
// One session describes a whole batch and is stored as a single blob in the
// `settings` table, so it survives a reload without a Dexie schema migration.
// Everything in it is local: the catalogue, the colour selection, the ink
// assignment and the placement all stay on this device.
// ---------------------------------------------------------------------------

import { getSetting, setSetting } from "@/lib/db/schema";
import type {
  StudioDesignPair,
  StudioInkPair,
  StudioListingMockupsApplied,
  StudioListingRender,
  StudioPlacement,
  StudioProductResult,
  StudioRowId,
  StudioRowState,
  StudioSession,
} from "@/types/domain";
import { DEFAULT_PLACEMENT } from "@/lib/printify/print-areas";
import { describeInkContrast, inkContrast } from "@/lib/printify/colors";

export const SESSION_KEY = "printifyStudio:session";
export const RESULTS_KEY = "printifyStudio:results";

export const ROWS: StudioRowId[] = ["plain", "ink"];

export const ROW_LABELS: Record<StudioRowId, string> = {
  plain: "No ink variants",
  ink: "Has ink variants",
};

export const ROW_HINTS: Record<StudioRowId, string> = {
  plain:
    "Designs in this row print ONLY the colours selected in this panel, with one artwork. Tick \u201cInk variants\u201d on a card to move it to the other row.",
  ink:
    "Designs in this row print ONLY the colours selected in this panel, with the ink artwork. Tick \u201cInk variants\u201d on a card to move it here.",
};

export function emptyRowState(): StudioRowState {
  return { colors: [], blackInkColors: [], whiteInkColors: [] };
}

export function emptySession(): StudioSession {
  return {
    sizes: [],
    rows: { plain: emptyRowState(), ink: emptyRowState() },
    designIds: [],
    inkPairIds: [],
    inkPairs: [],
    designPairIds: [],
    designPairs: [],
    inkRevision: 2,
    inkReset: false,
    universalPlacement: { ...DEFAULT_PLACEMENT },
    placements: {},
    placementsByPosition: {},
    priceCents: 1999,
    titleTemplate: "{design} — {product}",
    descriptionTemplate: "",
    tags: [],
    priceMode: "fixed",
    listingPrices: {},
    category: "",
    quantity: 1,
    listingImages: {},
    listingImageCleared: {},
    listingImageOrders: {},
    listingRenders: {},
    listingMockupsApplied: {},
    updatedAt: Date.now(),
  };
}

/** Only keeps values of the expected type, so a malformed store cannot crash. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Normalises one stored placement, or rejects it. */
function placementValue(value: unknown): StudioPlacement | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<StudioPlacement>;
  const fallback = DEFAULT_PLACEMENT;
  return {
    position: typeof p.position === "string" && p.position ? p.position : fallback.position,
    x: finiteNumber(p.x) ?? fallback.x,
    y: finiteNumber(p.y) ?? fallback.y,
    scale: finiteNumber(p.scale) ?? fallback.scale,
    angle: finiteNumber(p.angle) ?? fallback.angle,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveCents(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n > 0 ? Math.round(n) : undefined;
}

/** 13 tags of 20 characters - the strictest marketplace the drafts feed. */
export const MAX_TAGS = 13;
export const MAX_TAG_LENGTH = 20;

/** Parses a comma/newline separated tag field into the list the drafts store. */
export function parseTags(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : value.split(/[,\n]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = item.trim().replace(/^#+/, "").slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function tagArray(value: unknown): string[] {
  return Array.isArray(value) ? parseTags(stringArray(value)) : [];
}

function centsRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value)) {
    const cents = positiveCents(raw);
    if (key && cents !== undefined) out[key] = cents;
  }
  return out;
}

function imageSelectionRecord(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value || typeof value !== "object") return out;
  for (const [listingId, raw] of Object.entries(value)) {
    const ids = [...new Set(stringArray(raw))];
    if (listingId && ids.length > 0) out[listingId] = ids;
  }
  return out;
}

function clearedRecord(value: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (!value || typeof value !== "object") return out;
  for (const [listingId, raw] of Object.entries(value)) {
    if (listingId && raw === true) out[listingId] = true;
  }
  return out;
}

function appliedMockupRecord(
  value: unknown,
): Record<string, StudioListingMockupsApplied> {
  const out: Record<string, StudioListingMockupsApplied> = {};
  if (!value || typeof value !== "object") return out;
  for (const [listingId, raw] of Object.entries(value)) {
    if (!listingId || !raw || typeof raw !== "object") continue;
    const entry = raw as Partial<StudioListingMockupsApplied>;
    if (
      typeof entry.productId !== "string" ||
      !entry.productId ||
      typeof entry.signature !== "string" ||
      !entry.signature
    ) {
      continue;
    }
    out[listingId] = {
      productId: entry.productId,
      signature: entry.signature,
      appliedAt: finiteNumber(entry.appliedAt) ?? 0,
    };
  }
  return out;
}

function renderRecord(value: unknown): Record<string, StudioListingRender> {
  const out: Record<string, StudioListingRender> = {};
  if (!value || typeof value !== "object") return out;
  for (const raw of Object.values(value)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<StudioListingRender>;
    if (
      typeof entry.assetId !== "string" ||
      typeof entry.fingerprint !== "string" ||
      typeof entry.designId !== "string" ||
      typeof entry.mockupId !== "string"
    ) {
      continue;
    }
    // The key is derived from the entry, never trusted: a malformed blob must
    // not let another listing/mockup pair return these pixels.
    out[`${entry.designId}:${entry.mockupId}`] = {
      assetId: entry.assetId,
      fingerprint: entry.fingerprint,
      designId: entry.designId,
      mockupId: entry.mockupId,
      renderedAt: finiteNumber(entry.renderedAt) ?? Date.now(),
      ...(entry.source === "mockups" || entry.source === "listing"
        ? { source: entry.source }
        : {}),
    };
  }
  return out;
}

/**
 * Reads the stored pairs, dropping anything malformed.
 *
 * A design can only be in one pair, so the second pair naming an id already
 * seen is ignored. That keeps a half-written blob from printing one design on
 * two listings.
 */
function inkPairArray(value: unknown): StudioInkPair[] {
  if (!Array.isArray(value)) return [];
  const out: StudioInkPair[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const black = (entry as Partial<StudioInkPair>).blackInkDesignId;
    const white = (entry as Partial<StudioInkPair>).whiteInkDesignId;
    if (typeof black !== "string" || typeof white !== "string") continue;
    if (!black || !white || black === white) continue;
    if (seen.has(black) || seen.has(white)) continue;
    seen.add(black);
    seen.add(white);
    out.push({ blackInkDesignId: black, whiteInkDesignId: white });
  }
  return out;
}

/**
 * Reads the stored DESIGN pairs, dropping anything malformed.
 *
 * Same one-pair-per-design rule as ink pairs, but its own namespace: a
 * design pair never touches ink-pair state, and a design may legitimately
 * sit in one ink pair AND one design pair? No - a design can be in only one
 * pair of each kind, and the two kinds never share state. A design that is
 * already in a design pair is not added again.
 */
function designPairArray(value: unknown): StudioDesignPair[] {
  if (!Array.isArray(value)) return [];
  const out: StudioDesignPair[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const front = (entry as Partial<StudioDesignPair>).frontDesignId;
    const back = (entry as Partial<StudioDesignPair>).backDesignId;
    if (typeof front !== "string" || typeof back !== "string") continue;
    if (!front || !back || front === back) continue;
    if (seen.has(front) || seen.has(back)) continue;
    seen.add(front);
    seen.add(back);
    out.push({ frontDesignId: front, backDesignId: back });
  }
  return out;
}

/**
 * Reads the stored session, repairing anything missing or malformed.
 *
 * The stored value is untrusted: it may have been written by an older version
 * of the app, or be a partial write. Every field is checked, because a single
 * bad value (a number where a colour name is expected) would otherwise throw
 * during render and blank the whole page.
 */
export async function loadSession(): Promise<StudioSession> {
  const stored = await getSetting<Partial<StudioSession> | null>(SESSION_KEY, null);
  const base = emptySession();
  if (!stored || typeof stored !== "object") return base;

  const rows = { ...base.rows };
  /**
   * Sessions saved before `inkRevision: 2` hold the OLD automatic light/dark
   * split in their ink lists. Replaying it is what made "only the black
   * garment got the white-ink design" survive every reload, so a legacy
   * session clears the INK row ONCE. The plain ("No ink variants") row is
   * never touched: its colours are the user's own selection and carry no ink.
   */
  const inkRevision = finiteNumber(stored.inkRevision) ?? 1;
  const legacyInk = inkRevision < 2;
  let legacySplitCleared = false;

  for (const row of ROWS) {
    const rowState = stored.rows?.[row];
    if (!rowState || typeof rowState !== "object") continue;
    const colors = stringArray(rowState.colors);
    const blackInk = stringArray(rowState.blackInkColors).filter((c) => colors.includes(c));
    // White is EXPLICIT. An explicit `whiteInkColors: []` keeps its colours
    // undecided; only a pre-`whiteInkColors` session used to derive white from
    // "everything not marked black", and that derivation is gone - it was the
    // old automatic split.
    const whiteInk = Array.isArray(rowState.whiteInkColors)
      ? stringArray(rowState.whiteInkColors).filter(
          (c) => colors.includes(c) && !blackInk.includes(c),
        )
      : colors.filter((c) => !blackInk.includes(c));
    if (row === "plain") {
      // The plain row has no ink split at all - its designs print one artwork
      // on every selected colour. Keeping empty lists makes that explicit and
      // guarantees a legacy migration cannot write an ink choice here.
      rows[row] = { colors, blackInkColors: [], whiteInkColors: [] };
      continue;
    }
    if (legacyInk) {
      if (blackInk.length > 0 || whiteInk.length > 0) legacySplitCleared = true;
      rows[row] = { colors, blackInkColors: [], whiteInkColors: [] };
      continue;
    }
    rows[row] = { colors, blackInkColors: blackInk, whiteInkColors: whiteInk };
  }

  const placements: Record<string, StudioPlacement> = {};
  const rawPlacements = stored.placements;
  if (rawPlacements && typeof rawPlacements === "object") {
    for (const [designId, value] of Object.entries(rawPlacements)) {
      const p = placementValue(value);
      if (p) placements[designId] = p;
    }
  }

  const placementsByPosition: Record<string, Record<string, StudioPlacement>> = {};
  const rawByPosition = stored.placementsByPosition;
  if (rawByPosition && typeof rawByPosition === "object") {
    for (const [designId, record] of Object.entries(rawByPosition)) {
      if (!record || typeof record !== "object") continue;
      const perPosition: Record<string, StudioPlacement> = {};
      for (const [position, value] of Object.entries(record)) {
        const p = placementValue(value);
        if (p) perPosition[position] = p;
      }
      if (Object.keys(perPosition).length > 0) placementsByPosition[designId] = perPosition;
    }
  }

  const universalPlacement = {
    ...base.universalPlacement,
    ...(stored.universalPlacement && typeof stored.universalPlacement === "object"
      ? {
          position:
            typeof stored.universalPlacement.position === "string"
              ? stored.universalPlacement.position
              : base.universalPlacement.position,
          x: finiteNumber(stored.universalPlacement.x) ?? base.universalPlacement.x,
          y: finiteNumber(stored.universalPlacement.y) ?? base.universalPlacement.y,
          scale: finiteNumber(stored.universalPlacement.scale) ?? base.universalPlacement.scale,
          angle: finiteNumber(stored.universalPlacement.angle) ?? base.universalPlacement.angle,
        }
      : {}),
  };

  return {
    blueprintId: finiteNumber(stored.blueprintId),
    printProviderId: finiteNumber(stored.printProviderId),
    sizes: stringArray(stored.sizes),
    rows,
    designIds: stringArray(stored.designIds),
    inkPairIds: stringArray(stored.inkPairIds),
    inkPairs: inkPairArray(stored.inkPairs),
    designPairIds: stringArray(stored.designPairIds),
    designPairs: designPairArray(stored.designPairs),
    // Always 2 after a load: the next save records the explicit model, so the
    // one-time reset cannot run twice.
    inkRevision: 2,
    inkReset: legacySplitCleared || stored.inkReset === true,
    universalPlacement,
    placements,
    placementsByPosition,
    priceCents: positiveCents(stored.priceCents) ?? base.priceCents,
    titleTemplate: typeof stored.titleTemplate === "string" ? stored.titleTemplate : base.titleTemplate,
    descriptionTemplate:
      typeof stored.descriptionTemplate === "string" ? stored.descriptionTemplate : "",
    tags: tagArray(stored.tags),
    priceMode: stored.priceMode === "custom" ? "custom" : "fixed",
    listingPrices: centsRecord(stored.listingPrices),
    category: typeof stored.category === "string" ? stored.category : "",
    quantity:
      finiteNumber(stored.quantity) !== undefined && (stored.quantity as number) > 0
        ? Math.max(1, Math.round(stored.quantity as number))
        : 1,
    listingImages: imageSelectionRecord(stored.listingImages),
    listingImageCleared: clearedRecord(stored.listingImageCleared),
    // The GLOBAL image order. It is a plain list of mockup ids; duplicates are
    // dropped, because a repeated id would make the sort ambiguous.
    listingImageOrder: [...new Set(stringArray(stored.listingImageOrder))],
    // The per-design "Own order" overrides. Same sanitising as the explicit
    // selections: strings only, de-duplicated; an empty list is dropped
    // because a key with no order cannot express a detached row.
    listingImageOrders: imageSelectionRecord(stored.listingImageOrders),
    listingRenders: renderRecord(stored.listingRenders),
    listingMockupsApplied: appliedMockupRecord(stored.listingMockupsApplied),
    // UI memory for the Mockups panel's per-design tabs. A non-empty string
    // survives; anything else (including a deleted id, which the panel itself
    // re-validates against the live tables) is dropped.
    mockupsActiveDesignId:
      typeof stored.mockupsActiveDesignId === "string" && stored.mockupsActiveDesignId
        ? stored.mockupsActiveDesignId
        : undefined,
    mockupsActiveMockupId:
      typeof stored.mockupsActiveMockupId === "string" && stored.mockupsActiveMockupId
        ? stored.mockupsActiveMockupId
        : undefined,
    updatedAt: finiteNumber(stored.updatedAt) ?? Date.now(),
  };
}

export async function saveSession(session: StudioSession): Promise<void> {
  // Every save is explicit-model data from here on, even if the caller still
  // carries a legacy-shaped row object.
  await setSetting(SESSION_KEY, { ...session, inkRevision: 2, updatedAt: Date.now() });
}

export async function clearSession(): Promise<void> {
  await setSetting(SESSION_KEY, null);
}

/**
 * Removes a deleted design from the studio's state.
 *
 * The session lives in `settings`, which the design cascade in
 * `lib/db/repo.ts` does not touch, so without this a deleted design would
 * linger in the batch scope and in the results list - and the results list
 * would keep showing a Printify id for a design that no longer exists.
 */
export async function pruneStudioDesign(designId: string): Promise<void> {
  const session = await loadSession();
  const placements = { ...session.placements };
  let changed = false;
  if (designId in placements) {
    delete placements[designId];
    changed = true;
  }
  const placementsByPosition = { ...(session.placementsByPosition ?? {}) };
  if (designId in placementsByPosition) {
    delete placementsByPosition[designId];
    changed = true;
  }
  if (session.designIds.includes(designId)) {
    changed = true;
  }
  if (session.inkPairIds.includes(designId)) {
    changed = true;
  }
  const inkPairs = session.inkPairs.filter(
    (pair) => pair.blackInkDesignId !== designId && pair.whiteInkDesignId !== designId,
  );
  if (inkPairs.length !== session.inkPairs.length) {
    changed = true;
  }
  const designPairs = (session.designPairs ?? []).filter(
    (pair) => pair.frontDesignId !== designId && pair.backDesignId !== designId,
  );
  if (designPairs.length !== (session.designPairs ?? []).length) {
    changed = true;
  }
  if (session.designPairIds?.includes(designId)) {
    changed = true;
  }

  const listingImages = { ...(session.listingImages ?? {}) };
  if (designId in listingImages) {
    delete listingImages[designId];
    changed = true;
  }
  const listingImageCleared = { ...(session.listingImageCleared ?? {}) };
  if (designId in listingImageCleared) {
    delete listingImageCleared[designId];
    changed = true;
  }
  const listingImageOrders = { ...(session.listingImageOrders ?? {}) };
  if (designId in listingImageOrders) {
    delete listingImageOrders[designId];
    changed = true;
  }
  const listingPrices = { ...(session.listingPrices ?? {}) };
  if (designId in listingPrices) {
    delete listingPrices[designId];
    changed = true;
  }
  const listingRenders = { ...(session.listingRenders ?? {}) };
  for (const [key, entry] of Object.entries(listingRenders)) {
    if (entry.designId === designId || key.startsWith(`${designId}:`)) {
      delete listingRenders[key];
      changed = true;
    }
  }
  const listingMockupsApplied = { ...(session.listingMockupsApplied ?? {}) };
  if (designId in listingMockupsApplied) {
    delete listingMockupsApplied[designId];
    changed = true;
  }

  if (changed) {
    await saveSession({
      ...session,
      designIds: session.designIds.filter((id) => id !== designId),
      inkPairIds: session.inkPairIds.filter((id) => id !== designId),
      inkPairs,
      designPairIds: (session.designPairIds ?? []).filter((id) => id !== designId),
      designPairs,
      placements,
      placementsByPosition,
      listingImages,
      listingImageCleared,
      listingImageOrders,
      listingPrices,
      listingRenders,
      listingMockupsApplied,
    });
  }

  const results = await getSetting<StudioProductResult[]>(RESULTS_KEY, []);
  if (Array.isArray(results)) {
    const kept = results.filter((r) => r.designId !== designId);
    if (kept.length !== results.length) await setSetting(RESULTS_KEY, kept);
  }
}

/**
 * The placement for a design.
 *
 * A design owns its placement, and every mockup uses it: the print-area frame
 * maps that placement onto each photo. There is no "all designs share this"
 * mode - editing one design can never move another.
 *
 * With a `position`, the design's PER-POSITION placement wins when it has one
 * (`placementsByPosition[designId][position]`): the Adjust dialog keeps
 * separate FRONT and BACK values, and product creation sends the side's own
 * numbers. No per-position entry falls back to the shared placement, so
 * sessions saved before this existed behave exactly as before.
 */
export function placementFor(
  session: StudioSession,
  designId: string,
  position?: string,
): StudioPlacement {
  if (position) {
    const perPosition = session.placementsByPosition?.[designId]?.[position];
    if (perPosition) return perPosition;
  }
  return session.placements[designId] ?? session.universalPlacement;
}

/** Expands `{design}` and `{product}` in any listing template. */
export function renderTemplate(
  template: string | undefined,
  designName: string,
  productName: string,
  fallback = "",
  maxLength = 5000,
): string {
  const tpl = template?.trim() || fallback;
  return tpl
    .replace(/\{design\}/g, designName)
    .replace(/\{product\}/g, productName)
    .slice(0, maxLength)
    .trim();
}

/** Expands `{design}` and `{product}` in a title template. */
export function renderTitle(
  template: string | undefined,
  designName: string,
  productName: string,
): string {
  return renderTemplate(template, designName, productName, "{design} — {product}", 140);
}

/** The price a listing creates every variant with, in cents. */
export function priceForListing(session: StudioSession, listingId: string): number {
  const fixed = positiveCents(session.priceCents) ?? 1999;
  if (session.priceMode === "custom") {
    const custom = positiveCents(session.listingPrices?.[listingId]);
    if (custom !== undefined) return custom;
  }
  return fixed;
}

/**
 * Applies ONE stored order to a list of mockup ids.
 *
 * The rule is deliberately simple, and the global order and a listing's own
 * order both use it:
 *
 *  - a mockup that IS in the order comes first, in that order;
 *  - a mockup that is NOT in the order (a newly uploaded one, or one added
 *    while the order was already set) comes last, keeping its own order.
 *
 * Ids the caller did not pass are ignored, so an excluded mockup is skipped
 * rather than reserving a slot. No stored order = the ids unchanged.
 */
function applyOrder(order: string[] | undefined, ids: string[]): string[] {
  if (!order || order.length === 0) return ids;
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const known: string[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    if (rank.has(id)) known.push(id);
    else unknown.push(id);
  }
  known.sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number));
  return [...known, ...unknown];
}

/** Merges a dragged list into one stored order, hidden ids keeping their slot. */
function mergeOrder(previous: string[] | undefined, dragged: string[]): string[] {
  const draggedSet = new Set(dragged);
  const rest = (previous ?? []).filter((id) => !draggedSet.has(id));
  return [...dragged, ...rest];
}

/**
 * Applies the GLOBAL image order to a list of mockup ids.
 *
 * One order is shared by every listing, so the main photograph is the same on
 * every product in the batch.
 */
export function applyGlobalOrder(session: StudioSession, ids: string[]): string[] {
  return applyOrder(session.listingImageOrder, ids);
}

/**
 * Writes a new global order.
 *
 * The dragged list only holds the mockups the user can see, so the ids that
 * were not in it keep their previous relative positions at the end - a mockup
 * that is hidden in one row (for example an info card, or a row that filters
 * the library) must not lose its slot.
 */
export function mergeGlobalOrder(
  session: StudioSession,
  dragged: string[],
): string[] {
  return mergeOrder(session.listingImageOrder, dragged);
}

/**
 * Merges a dragged list into ONE listing's own order entry.
 *
 * Same merge rule as the global order; the caller owns whether the entry is
 * created or deleted (the "Own order" toggle), so passing no previous value
 * simply stores the dragged list.
 */
export function mergeOwnOrder(
  previous: string[] | undefined,
  dragged: string[],
): string[] {
  return mergeOrder(previous, dragged);
}

/**
 * The order ids take for ONE listing.
 *
 * A design whose "Own order" toggle is ON (a key in `listingImageOrders`)
 * sorts by its own entry; every other design uses the shared global order.
 * This is the single resolver the tile strip, the drafts engine, the preview,
 * the Export Center and the Printify bridge all read, so what the row shows
 * is exactly what gets uploaded. An own entry that is empty (never populated)
 * falls back to the shared order rather than silently displaying nothing.
 */
export function orderedIdsForListing(
  session: StudioSession,
  listingId: string,
  ids: string[],
): string[] {
  const own = session.listingImageOrders?.[listingId];
  // Toggle ON with a real entry -> the own order; every other case (no key,
  // or an entry with no usable ids) -> the shared global order.
  const order = own && own.length > 0 ? own : session.listingImageOrder;
  return applyOrder(order, ids);
}

/**
 * The selected mockup ids for a listing, in the order that listing uses.
 *
 * `session.listingImages` says WHICH mockups a listing uses; the order (own
 * when the design is detached, shared otherwise) says in what order they go.
 * The first id is the main image.
 */
export function listingMockupIds(session: StudioSession, listingId: string): string[] {
  return orderedIdsForListing(session, listingId, session.listingImages?.[listingId] ?? []);
}

/**
 * Moves listing state from one owner to another when the user swaps the
 * black/white halves of a pair. The listing identity is the black design's id,
 * so without this the new owner would look unconfigured while the old draft
 * kept its locked images.
 */
export function remapListingState(
  session: StudioSession,
  fromId: string,
  toId: string,
): Partial<StudioSession> {
  if (!fromId || !toId || fromId === toId) return {};

  const move = <T>(record: Record<string, T> | undefined): Record<string, T> => {
    const next = { ...(record ?? {}) };
    const value = next[fromId];
    delete next[fromId];
    delete next[toId];
    if (value !== undefined) next[toId] = value;
    return next;
  };

  const listingRenders: Record<string, StudioListingRender> = {};
  for (const entry of Object.values(session.listingRenders ?? {})) {
    if (entry.designId === fromId) {
      listingRenders[`${toId}:${entry.mockupId}`] = { ...entry, designId: toId };
    } else if (entry.designId !== toId) {
      listingRenders[`${entry.designId}:${entry.mockupId}`] = entry;
    }
  }

  return {
    listingImages: move(session.listingImages),
    listingImageCleared: move(session.listingImageCleared),
    listingImageOrders: move(session.listingImageOrders),
    listingPrices: move(session.listingPrices),
    listingRenders,
    listingMockupsApplied: move(session.listingMockupsApplied),
  };
}

/** The cached render for a listing/mockup pair, if one was recorded. */
export function listingRenderFor(
  session: StudioSession,
  listingId: string,
  mockupId: string,
): StudioListingRender | undefined {
  return session.listingRenders?.[`${listingId}:${mockupId}`];
}

/** The colour names a row selected, in the order they were picked. */
export function rowColors(session: StudioSession, row: StudioRowId): string[] {
  return session.rows[row]?.colors ?? [];
}

/**
 * The ink a colour uses in the ink row: "black" or "white" when the user
 * marked it, "undecided" when they have not chosen yet.
 */
export function inkForColor(
  session: StudioSession,
  color: string,
): "black" | "white" | "undecided" {
  const row = session.rows.ink;
  if (row?.blackInkColors?.includes(color)) return "black";
  if (row?.whiteInkColors?.includes(color)) return "white";
  return "undecided";
}

export interface InkProblem {
  name: string;
  ink: "black" | "white";
  /** "none" means the artwork would be invisible. */
  severity: "none" | "low";
  message: string;
}

/**
 * The colours whose ink will not read against the garment.
 *
 * The ink a colour uses is the user's choice (marked colours use the black
 * ink, the rest the white ink), so this checks the CHOICE rather than
 * guessing it: black ink on a black shirt is invisible, and that is easy to
 * do by accident.
 */
export function inkProblems(
  session: StudioSession,
  hexFor: (name: string) => string,
): InkProblem[] {
  const problems: InkProblem[] = [];
  for (const name of session.rows.ink?.colors ?? []) {
    const ink = inkForColor(session, name);
    if (ink === "undecided") continue;
    const hex = hexFor(name);
    const severity = inkContrast(hex, ink);
    if (severity === "ok") continue;
    problems.push({ name, ink, severity, message: describeInkContrast(hex, ink) });
  }
  return problems;
}
