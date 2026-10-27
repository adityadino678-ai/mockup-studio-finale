import { db } from "./schema";
import { deleteAsset } from "./repo";
import type { AssetMeta } from "@/types/domain";

/**
 * Share of total quota at which the UI shows a storage warning.
 */
export const STORAGE_WARN_THRESHOLD = 0.70;

/**
 * Share of total quota at which the oldest assets are auto-pruned.
 */
export const STORAGE_PRUNE_THRESHOLD = 0.90;

export interface StorageInfo {
  /** Bytes used. */
  usage: number;
  /** Bytes available (quota). */
  quota: number;
  /** Usage as a percentage of quota (0-100). */
  percent: number;
}

export interface PrunedAsset {
  id: string;
  name: string;
  size: number;
  kind: AssetMeta["kind"];
}

export interface PruneResult {
  /** Assets that were deleted, oldest first, for user notification. */
  pruned: PrunedAsset[];
  /** Total bytes freed by the prune. */
  freedBytes: number;
  /** Estimated storage percent after pruning (0-100), or null when the
   * estimate is unavailable. */
  finalPercent: number | null;
}

/**
 * Read the browser's storage estimate for the current origin.
 *
 * Returns null when the Storage Estimation API is unavailable or reports no
 * usable quota, so callers can degrade gracefully ("estimate unavailable").
 */
export async function getStorageEstimate(): Promise<StorageInfo | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return null;
  }
  const est = await navigator.storage.estimate();
  if (est.usage == null || est.quota == null || est.quota <= 0) {
    return null;
  }
  return {
    usage: est.usage,
    quota: est.quota,
    percent: (est.usage / est.quota) * 100,
  };
}

export function isAtWarnThreshold(percent: number): boolean {
  return percent >= STORAGE_WARN_THRESHOLD * 100;
}

export function isAtPruneThreshold(percent: number): boolean {
  return percent >= STORAGE_PRUNE_THRESHOLD * 100;
}

/**
 * Collect the ids of assets still referenced by a design, mockup, or listing
 * draft, so pruning never deletes an asset in use.
 */
async function referencedAssetIds(): Promise<Set<string>> {
  const referenced = new Set<string>();

  const designs = await db.designs.toArray();
  for (const d of designs) {
    [d.originalAssetId, d.processedAssetId, d.whiteInkAssetId, d.blackInkAssetId]
      .filter((id): id is string => !!id)
      .forEach((id) => referenced.add(id));
  }

  const mockups = await db.mockups.toArray();
  for (const m of mockups) {
    if (m.assetId) referenced.add(m.assetId);
  }

  const drafts = await db.listingDrafts.toArray();
  for (const d of drafts) {
    for (const id of d.imageAssetIds) referenced.add(id);
  }

  return referenced;
}

/**
 * The oldest asset that is safe to delete, or undefined when every asset is
 * still referenced somewhere.
 */
async function oldestPrunableAsset(): Promise<AssetMeta | undefined> {
  const referenced = await referencedAssetIds();
  const all = await db.assets.orderBy("createdAt").toArray();
  return all.find((asset) => !referenced.has(asset.id));
}

/**
 * Auto-prune the oldest assets when storage is at or above the prune
 * threshold (90%).
 *
 * Enough oldest assets are deleted to bring estimated usage back below the
 * warn threshold (70%), stopping early when no prunable assets remain. Assets
 * still referenced by a design, mockup, or listing draft are skipped.
 *
 * Returns the pruned assets so the caller can notify the user which assets
 * were removed.
 */
export async function autoPruneOldestAssets(): Promise<PruneResult> {
  const pruned: PrunedAsset[] = [];
  let freedBytes = 0;

  const current = await getStorageEstimate();
  if (current == null || !isAtPruneThreshold(current.percent)) {
    return { pruned, freedBytes: 0, finalPercent: current?.percent ?? null };
  }

  // Free enough bytes to get back below the warn threshold.
  const targetBytes = Math.max(
    0,
    current.usage - STORAGE_WARN_THRESHOLD * current.quota,
  );

  while (freedBytes < targetBytes) {
    const candidate = await oldestPrunableAsset();
    if (!candidate) break;

    const { id, name, size, kind } = candidate;
    await deleteAsset(id);
    pruned.push({ id, name, size, kind });
    freedBytes += size;
  }

  const finalPercent = Math.max(
    0,
    ((current.usage - freedBytes) / current.quota) * 100,
  );
  return { pruned, freedBytes, finalPercent };
}
