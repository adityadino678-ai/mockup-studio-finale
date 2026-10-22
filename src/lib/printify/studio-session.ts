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
    universal: true,
    universalPlacement: { ...DEFAULT_PLACEMENT },
    placements: {},
    priceCents: 1999,
    titleTemplate: "{design} — {product}",
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
    universal: stored.universal !== false,
    universalPlacement,
    placements,
    priceCents: finiteNumber(stored.priceCents) ?? base.priceCents,
    titleTemplate: typeof stored.titleTemplate === "string" ? stored.titleTemplate : base.titleTemplate,
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
  if (changed) {
    await saveSession({
      ...session,
      designIds: session.designIds.filter((id) => id !== designId),
      inkPairIds: session.inkPairIds.filter((id) => id !== designId),
      placements,
    });
  }

  const results = await getSetting<StudioProductResult[]>(RESULTS_KEY, []);
  if (Array.isArray(results)) {
    const kept = results.filter((r) => r.designId !== designId);
    if (kept.length !== results.length) await setSetting(RESULTS_KEY, kept);
  }
}

/** The placement that applies to a design, honouring the universal toggle. */
export function placementFor(
  session: StudioSession,
  designId: string,
): StudioPlacement {
  if (session.universal) return session.universalPlacement;
  return session.placements[designId] ?? session.universalPlacement;
}

/** Expands `{design}` and `{product}` in a title template. */
export function renderTitle(
  template: string | undefined,
  designName: string,
  productName: string,
): string {
  const tpl = template?.trim() || "{design} — {product}";
  return tpl
    .replace(/\{design\}/g, designName)
    .replace(/\{product\}/g, productName)
    .slice(0, 140);
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
