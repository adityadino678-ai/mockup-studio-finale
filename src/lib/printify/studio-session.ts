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
  StudioInkPair,
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
    'These designs print one artwork on every colour. Tick "Ink variants" on a card to move it to the other row.',
  ink: 'These designs also print their ink artwork on the ink colours. Tick "Ink variants" on a card to move it here.',
};

export function emptyRowState(): StudioRowState {
  return { colors: [], blackInkColors: [] };
}

export function emptySession(): StudioSession {
  return {
    sizes: [],
    rows: { plain: emptyRowState(), ink: emptyRowState() },
    designIds: [],
    inkPairIds: [],
    inkPairs: [],
    universalPlacement: { ...DEFAULT_PLACEMENT },
    placements: {},
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
    listingRenders: {},
    updatedAt: Date.now(),
  };
}

/** Only keeps values of the expected type, so a malformed store cannot crash. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
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
  for (const row of ROWS) {
    const rowState = stored.rows?.[row];
    if (!rowState || typeof rowState !== "object") continue;
    rows[row] = {
      colors: stringArray(rowState.colors),
      blackInkColors: stringArray(rowState.blackInkColors).filter((c) =>
        stringArray(rowState.colors).includes(c),
      ),
    };
  }

  const placements: Record<string, StudioPlacement> = {};
  const rawPlacements = stored.placements;
  if (rawPlacements && typeof rawPlacements === "object") {
    for (const [designId, value] of Object.entries(rawPlacements)) {
      if (!value || typeof value !== "object") continue;
      const p = value as Partial<StudioPlacement>;
      placements[designId] = {
        position: typeof p.position === "string" ? p.position : base.universalPlacement.position,
        x: finiteNumber(p.x) ?? base.universalPlacement.x,
        y: finiteNumber(p.y) ?? base.universalPlacement.y,
        scale: finiteNumber(p.scale) ?? base.universalPlacement.scale,
        angle: finiteNumber(p.angle) ?? base.universalPlacement.angle,
      };
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
    universalPlacement,
    placements,
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
    listingRenders: renderRecord(stored.listingRenders),
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
  await setSetting(SESSION_KEY, { ...session, updatedAt: Date.now() });
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

  if (changed) {
    await saveSession({
      ...session,
      designIds: session.designIds.filter((id) => id !== designId),
      inkPairIds: session.inkPairIds.filter((id) => id !== designId),
      inkPairs,
      placements,
      listingImages,
      listingImageCleared,
      listingPrices,
      listingRenders,
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
 * A design owns ONE placement, and every mockup uses it: the print-area frame
 * maps that placement onto each photo. There is no "all designs share this"
 * mode - editing one design can never move another.
 */
export function placementFor(
  session: StudioSession,
  designId: string,
): StudioPlacement {
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

/** The selected mockup ids for a listing, in click order. */
export function listingMockupIds(session: StudioSession, listingId: string): string[] {
  return session.listingImages?.[listingId] ?? [];
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
    listingPrices: move(session.listingPrices),
    listingRenders,
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
 * The ink a colour uses in the ink row: "black" for the colours the user
 * marked, "white" for the rest.
 */
export function inkForColor(session: StudioSession, color: string): "black" | "white" {
  return session.rows.ink?.blackInkColors?.includes(color) ? "black" : "white";
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
    const hex = hexFor(name);
    const severity = inkContrast(hex, ink);
    if (severity === "ok") continue;
    problems.push({ name, ink, severity, message: describeInkContrast(hex, ink) });
  }
  return problems;
}
