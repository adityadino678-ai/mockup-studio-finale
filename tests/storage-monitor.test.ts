import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db/schema";
import {
  autoPruneOldestAssets,
  getStorageEstimate,
  isAtPruneThreshold,
  isAtWarnThreshold,
  STORAGE_PRUNE_THRESHOLD,
  STORAGE_WARN_THRESHOLD,
} from "@/lib/db/storage-monitor";
import type { AssetMeta } from "@/types/domain";

function installStorageEstimate(usage: number, quota: number): void {
  const estimate = vi.fn(async () => ({ usage, quota }));
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    get: () => ({ estimate }),
  });
}

function uninstallStorageEstimate(): void {
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: undefined,
  });
}

function seedAsset(overrides: Partial<AssetMeta>): AssetMeta {
  const asset: AssetMeta = {
    id: overrides.id ?? "asset-1",
    kind: "mockup-render",
    name: overrides.name ?? "render.png",
    mime: "image/png",
    width: 100,
    height: 100,
    size: overrides.size ?? 1000,
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  };
  void db.assets.put(asset);
  void db.blobs.put({ id: asset.id, blob: new Blob([]) });
  return asset;
}

async function countAssets(): Promise<number> {
  return db.assets.count();
}

describe("storage monitor", () => {
  beforeEach(async () => {
    await db.assets.clear();
    await db.blobs.clear();
    await db.designs.clear();
    await db.mockups.clear();
    await db.listingDrafts.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallStorageEstimate();
  });

  describe("getStorageEstimate", () => {
    it("returns null when the estimate API is unavailable", () => {
      // The default jsdom navigator.storage may be absent; uninstall simulates that.
      uninstallStorageEstimate();
      return expect(getStorageEstimate()).resolves.toBeNull();
    });

    it("returns usage, quota and percent", async () => {
      installStorageEstimate(700_000_000, 1_000_000_000);
      const info = await getStorageEstimate();
      expect(info).toEqual({
        usage: 700_000_000,
        quota: 1_000_000_000,
        percent: 70,
      });
    });

    it("returns null when quota is zero or missing", async () => {
      installStorageEstimate(100, 0);
      expect(await getStorageEstimate()).toBeNull();
    });
  });

  describe("thresholds", () => {
    it("warn threshold is 70%", () => {
      expect(STORAGE_WARN_THRESHOLD).toBe(0.7);
      expect(isAtWarnThreshold(70)).toBe(true);
      expect(isAtWarnThreshold(69.99)).toBe(false);
    });

    it("prune threshold is 90%", () => {
      expect(STORAGE_PRUNE_THRESHOLD).toBe(0.9);
      expect(isAtPruneThreshold(90)).toBe(true);
      expect(isAtPruneThreshold(89.99)).toBe(false);
    });
  });

  describe("autoPruneOldestAssets", () => {
    it("does nothing when below the prune threshold", async () => {
      installStorageEstimate(500_000_000, 1_000_000_000); // 50%
      seedAsset({ id: "a1", createdAt: 1000, size: 1000 });

      const result = await autoPruneOldestAssets();

      expect(result.pruned).toEqual([]);
      expect(result.freedBytes).toBe(0);
      expect(await countAssets()).toBe(1);
    });

    it("prunes the oldest assets first until below the warn threshold", async () => {
      // Start at 95%, above the prune threshold.
      installStorageEstimate(950_000_000, 1_000_000_000);

      // Oldest to newest.
      seedAsset({ id: "oldest", createdAt: 1000, name: "oldest.png", size: 300_000_000 });
      seedAsset({ id: "middle", createdAt: 2000, name: "middle.png", size: 300_000_000 });
      seedAsset({ id: "newest", createdAt: 3000, name: "newest.png", size: 300_000_000 });

      const result = await autoPruneOldestAssets();

      // Oldest is pruned first. After removing one 300MB asset we drop to ~65%,
      // which is below the 70% warn threshold, so pruning stops.
      expect(result.pruned.map((p) => p.id)).toEqual(["oldest"]);
      expect(result.freedBytes).toBe(300_000_000);
      expect(await countAssets()).toBe(2);
      expect(result.finalPercent).toBeLessThan(70);
    });

    it("skips assets still referenced by a design, mockup, or listing draft", async () => {
      installStorageEstimate(950_000_000, 1_000_000_000);

      const referenced = seedAsset({
        id: "referenced",
        name: "referenced.png",
        createdAt: 1000,
        size: 400_000_000,
      });
      const unreferenced = seedAsset({
        id: "unreferenced",
        name: "unreferenced.png",
        createdAt: 2000,
        size: 400_000_000,
      });

      // Reference the oldest asset from a design so it must be skipped.
      await db.designs.put({
        id: "d1",
        name: "Design",
        tags: [],
        originalAssetId: referenced.id,
        createdAt: 1,
        updatedAt: 1,
        activeVariant: "main",
      });

      const result = await autoPruneOldestAssets();

      expect(result.pruned.map((p) => p.id)).toEqual([unreferenced.id]);
      expect(result.pruned.map((p) => p.name)).toEqual(["unreferenced.png"]);
      // The referenced asset must survive.
      expect(await db.assets.get(referenced.id)).toBeDefined();
      expect(await db.assets.get(unreferenced.id)).toBeUndefined();
    });

    it("stops pruning when no prunable assets remain", async () => {
      installStorageEstimate(950_000_000, 1_000_000_000);

      const asset = seedAsset({ id: "only", createdAt: 1000, size: 100_000_000 });
      await db.designs.put({
        id: "d1",
        name: "Design",
        tags: [],
        originalAssetId: asset.id,
        createdAt: 1,
        updatedAt: 1,
        activeVariant: "main",
      });

      const result = await autoPruneOldestAssets();

      expect(result.pruned).toEqual([]);
      expect(await db.assets.get(asset.id)).toBeDefined();
    });
  });
});
