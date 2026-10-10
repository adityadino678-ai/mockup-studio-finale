"use client";

import { create } from "zustand";

interface DesignSelectionState {
  selectedDesignIds: string[];
  toggle: (id: string) => void;
  setSelection: (ids: string[]) => void;
  addMany: (ids: string[]) => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
}

export const useDesignSelection = create<DesignSelectionState>((set, get) => ({
  selectedDesignIds: [],
  toggle: (id) => {
    const cur = get().selectedDesignIds;
    set({ selectedDesignIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  setSelection: (ids) => set({ selectedDesignIds: ids }),
  addMany: (ids) =>
    set((s) => ({ selectedDesignIds: Array.from(new Set([...s.selectedDesignIds, ...ids])) })),
  clear: () => set({ selectedDesignIds: [] }),
  isSelected: (id) => get().selectedDesignIds.includes(id),
}));

interface MockupSelectionState {
  selectedMockupIds: string[];
  toggle: (id: string) => void;
  setSelection: (ids: string[]) => void;
  clear: () => void;
}

export const useMockupSelection = create<MockupSelectionState>((set, get) => ({
  selectedMockupIds: [],
  toggle: (id) => {
    const cur = get().selectedMockupIds;
    set({ selectedMockupIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  setSelection: (ids) => set({ selectedMockupIds: ids }),
  clear: () => set({ selectedMockupIds: [] }),
}));
