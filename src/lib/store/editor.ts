"use client";

import { create } from "zustand";
import { DEFAULT_TRANSFORM, type Transform } from "@/types/domain";

export interface EditorSnapshot {
  designAssetId: string;
  transform: Transform;
  behindMockup: boolean;
}

function snapshotsEqual(a: EditorSnapshot | null, b: EditorSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

interface EditorStore {
  designId: string | null;
  mockupId: string | null;
  current: EditorSnapshot | null;
  saved: EditorSnapshot | null;
  history: EditorSnapshot[];
  historyIndex: number;

  init: (designId: string, mockupId: string, current: EditorSnapshot, saved: EditorSnapshot | null) => void;
  /** Update the current snapshot. record=true pushes to history (discrete operations only). */
  update: (partial: Partial<EditorSnapshot>, record?: boolean) => void;
  setTransform: (transform: Transform, record?: boolean) => void;
  /** Push the current (live-updated) state into history as a discrete step. */
  commit: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  resetTransform: () => void;
  clear: () => void;
}

const HISTORY_LIMIT = 60;

export const useEditorStore = create<EditorStore>((set, get) => ({
  designId: null,
  mockupId: null,
  current: null,
  saved: null,
  history: [],
  historyIndex: -1,

  init: (designId, mockupId, current, saved) =>
    set({
      designId,
      mockupId,
      current,
      saved,
      history: [current],
      historyIndex: 0,
    }),

  update: (partial, record = false) => {
    const { current, history, historyIndex } = get();
    if (!current) return;
    const next = { ...current, ...partial };
    if (snapshotsEqual(current, next)) return;
    if (record) {
      const trimmed = history.slice(0, historyIndex + 1);
      trimmed.push(next);
      if (trimmed.length > HISTORY_LIMIT) trimmed.shift();
      set({ current: next, history: trimmed, historyIndex: trimmed.length - 1 });
    } else {
      set({ current: next });
    }
  },

  setTransform: (transform, record = false) => get().update({ transform }, record),

  commit: () => {
    const { current, history, historyIndex } = get();
    if (!current) return;
    if (snapshotsEqual(current, history[historyIndex])) return;
    const trimmed = history.slice(0, historyIndex + 1);
    trimmed.push({ ...current });
    if (trimmed.length > HISTORY_LIMIT) trimmed.shift();
    set({ current: { ...current }, history: trimmed, historyIndex: trimmed.length - 1 });
  },

  undo: () => {
    const { history, historyIndex, current } = get();
    if (historyIndex <= 0) return;
    const idx = historyIndex - 1;
    const prev = history[idx];
    // Undo/redo should not create history entries; but current may have live
    // (uncommitted) changes — replace them by the target snapshot.
    const newHistory = [...history];
    if (current && !snapshotsEqual(current, history[historyIndex])) {
      newHistory[historyIndex] = current;
    }
    set({ current: prev, history: newHistory, historyIndex: idx });
  },

  redo: () => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const idx = historyIndex + 1;
    set({ current: history[idx], historyIndex: idx });
  },

  markSaved: () => {
    const { current } = get();
    if (!current) return;
    set({ saved: { ...current } });
  },

  resetTransform: () => {
    const { current } = get();
    if (!current) return;
    get().update({ transform: { ...DEFAULT_TRANSFORM } }, true);
  },

  clear: () =>
    set({ designId: null, mockupId: null, current: null, saved: null, history: [], historyIndex: -1 }),
}));

export function selectDirty(s: EditorStore): boolean {
  return !snapshotsEqual(s.current, s.saved);
}

export function selectCanUndo(s: EditorStore): boolean {
  return s.historyIndex > 0;
}

export function selectCanRedo(s: EditorStore): boolean {
  return s.historyIndex < s.history.length - 1;
}
