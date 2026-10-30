import { describe, expect, it } from "vitest";
import { db, setSetting } from "@/lib/db/schema";
import { loadSession, saveSession, SESSION_KEY } from "@/lib/printify/studio-session";
import type { StudioSession } from "@/types/domain";

/**
 * The saved Black ink / White ink switch is authoritative: loadSession must
 * never re-assign a colour based on garment lightness, and must never flip
 * colours between black-ink and white-ink on reload.
 */
describe("loadSession preserves the saved ink split", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("keeps a mixed black/white split exactly as saved", async () => {
    await saveSession({
      rows: {
        plain: { colors: ["White"], blackInkColors: [] },
        ink: {
          colors: ["Solid Black", "Navy", "White", "Sand"],
          blackInkColors: ["White", "Sand"],
        },
      },
    } as unknown as StudioSession);

    const loaded = await loadSession();

    expect(loaded.rows.ink?.colors).toEqual(["Solid Black", "Navy", "White", "Sand"]);
    // Black ink colours stay black-ink; white-ink colours stay white-ink.
    expect(loaded.rows.ink?.blackInkColors).toEqual(["White", "Sand"]);
  });

  it("keeps an all-black-ink split instead of rebalancing to white ink", async () => {
    await saveSession({
      rows: {
        plain: { colors: [], blackInkColors: [] },
        ink: { colors: ["Black", "Navy", "Charcoal"], blackInkColors: ["Black", "Navy", "Charcoal"] },
      },
    } as unknown as StudioSession);

    const loaded = await loadSession();

    expect(loaded.rows.ink?.blackInkColors).toEqual(["Black", "Navy", "Charcoal"]);
  });

  it("keeps an all-white-ink split instead of rebalancing to black ink", async () => {
    await saveSession({
      rows: {
        plain: { colors: [], blackInkColors: [] },
        ink: { colors: ["Black", "Navy", "Charcoal"], blackInkColors: [] },
      },
    } as unknown as StudioSession);

    const loaded = await loadSession();

    expect(loaded.rows.ink?.blackInkColors).toEqual([]);
  });

  it("drops black-ink colours that are no longer selected", async () => {
    await saveSession({
      rows: {
        plain: { colors: [], blackInkColors: [] },
        ink: { colors: ["Black", "Navy"], blackInkColors: ["Black", "Navy", "Removed Colour"] },
      },
    } as unknown as StudioSession);

    const loaded = await loadSession();

    expect(loaded.rows.ink?.blackInkColors).toEqual(["Black", "Navy"]);
  });
});

describe("loadSession and the new whiteInkColors field", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("keeps an explicit white list exactly as saved", async () => {
    await saveSession({
      rows: {
        plain: { colors: [], blackInkColors: [], whiteInkColors: [] },
        ink: {
          colors: ["Solid Black", "Navy", "White", "Sand"],
          blackInkColors: ["Solid Black", "Navy"],
          whiteInkColors: ["White", "Sand"],
        },
      },
    } as unknown as StudioSession);

    const loaded = await loadSession();

    expect(loaded.rows.ink?.whiteInkColors).toEqual(["White", "Sand"]);
    expect(loaded.rows.ink?.blackInkColors).toEqual(["Solid Black", "Navy"]);
  });

  it("resolves a colour in both lists to black and removes it from white", async () => {
    await saveSession({
      rows: {
        plain: { colors: [], blackInkColors: [], whiteInkColors: [] },
        ink: {
          colors: ["Solid Black", "Navy", "White"],
          blackInkColors: ["Solid Black", "Navy"],
          whiteInkColors: ["Navy", "White"],
        },
      },
    } as unknown as StudioSession);

    const loaded = await loadSession();

    expect(loaded.rows.ink?.blackInkColors).toEqual(["Solid Black", "Navy"]);
    expect(loaded.rows.ink?.whiteInkColors).toEqual(["White"]);
  });

  it("clears a legacy automatic split once and leaves the plain row alone", async () => {
    // Written the way the OLD app wrote it: no `inkRevision`, no
    // `whiteInkColors`. These lists are the old light/dark GUESS, not choices.
    await setSetting(SESSION_KEY, {
      rows: {
        plain: { colors: ["White", "Sand"], blackInkColors: [] },
        ink: {
          colors: ["Solid Black", "Navy", "White", "Sand"],
          blackInkColors: ["White", "Sand"],
        },
      },
    });

    const loaded = await loadSession();

    // The guess is gone: nothing is decided, so nothing prints until marked.
    expect(loaded.rows.ink?.blackInkColors).toEqual([]);
    expect(loaded.rows.ink?.whiteInkColors).toEqual([]);
    expect(loaded.rows.ink?.colors).toEqual(["Solid Black", "Navy", "White", "Sand"]);
    // The "No ink variants" row is the user's selection and is NOT touched.
    expect(loaded.rows.plain?.colors).toEqual(["White", "Sand"]);
    expect(loaded.rows.plain?.blackInkColors).toEqual([]);
    expect(loaded.rows.plain?.whiteInkColors).toEqual([]);
    // The user is told why, and the model is now explicit.
    expect(loaded.inkReset).toBe(true);
    expect(loaded.inkRevision).toBe(2);
  });

  it("does not clear an explicit split on the next load", async () => {
    await saveSession({
      rows: {
        plain: { colors: ["White"], blackInkColors: [], whiteInkColors: [] },
        ink: {
          colors: ["Solid Black", "Navy"],
          blackInkColors: ["Solid Black"],
          whiteInkColors: ["Navy"],
        },
      },
    } as unknown as StudioSession);

    const loaded = await loadSession();
    const reloaded = await loadSession();

    expect(loaded.rows.ink?.blackInkColors).toEqual(["Solid Black"]);
    expect(loaded.rows.ink?.whiteInkColors).toEqual(["Navy"]);
    expect(reloaded.rows.ink?.blackInkColors).toEqual(["Solid Black"]);
    expect(reloaded.rows.ink?.whiteInkColors).toEqual(["Navy"]);
    expect(reloaded.inkReset).toBe(false);
  });

  it("keeps colours UNDECIDED when whiteInkColors is [] - no implicit white", async () => {
    await saveSession({
      rows: {
        plain: { colors: [], blackInkColors: [], whiteInkColors: [] },
        ink: {
          colors: ["Solid Black", "Navy"],
          blackInkColors: [],
          whiteInkColors: [],
        },
      },
    } as unknown as StudioSession);

    const loaded = await loadSession();

    expect(loaded.rows.ink?.whiteInkColors).toEqual([]);
    expect(loaded.rows.ink?.blackInkColors).toEqual([]);
    // Neither list claims the colours - they are undecided until the user picks.
    expect(loaded.rows.ink?.colors).toEqual(["Solid Black", "Navy"]);
  });
});
