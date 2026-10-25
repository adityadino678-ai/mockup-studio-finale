// ---------------------------------------------------------------------------
// Adopting an existing mockup render for a listing image.
//
// A render produced anywhere in the app — the Mockups panel's Save render,
// the batch engine, the agent's `create_mockup_render` — stores its
// fingerprint as `renderFp` on the asset's meta (`renderComposition` in
// src/lib/batch/runner.ts writes it; `computeRenderFingerprint` in
// src/lib/printify/listing-render.ts defines it). When that recorded
// fingerprint equals what the listing path hashes RIGHT NOW — same design
// asset, mockup, print-area fields, Studio placement, fallback transform and
// behind-garment mode — the stored pixels are exactly what
// `renderListingMockup` would produce, so the listing can ADOPT the asset
// instead of rendering it again.
//
// One matching rule, two lookups:
//   * `buildAdoptionIndex` + `matchInAdoptionIndex` — synchronous, over the
//     live assets query the Listing images page already holds, for drawing
//     tiles and for the auto-adoption bookkeeping effect;
//   * `findAdoptableRender` — the same rule queried on demand, for the render
//     loop, which runs long enough that a fresh read is worth it.
//
// An asset without a recorded `renderFp` cannot prove what produced it, so it
// is never adopted automatically — the listing re-renders instead of guessing.
//
// Renders that PREDATE the fingerprint (saved before `renderFp` existed) can
// never match, and that is not a reason to hide the user's library. The
// second, deliberately manual path below finds the newest saved render of a
// pair whatever fingerprint it carries (`buildSavedRenderIndex`,
// `latestSavedRenderIn`, `findLatestSavedRender`) and turns it into a session
// entry under the CURRENT fingerprint (`linkSavedRenderEntries`). Only an
// explicit click calls that; nothing is ever linked silently.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db/schema";
import type { AssetMeta, StudioListingRender } from "@/types/domain";

/** The index key for one (artwork asset, mockup) pair. */
function adoptionKey(artworkAssetId: string, mockupId: string): string {
  return `${artworkAssetId}:${mockupId}`;
}

/**
 * Groups render assets by the pair they were rendered from, newest first.
 *
 * Only `mockup-render` assets carrying a fingerprint and both source ids are
 * indexed; everything else is skipped rather than guessed at.
 */
export function buildAdoptionIndex(assets: AssetMeta[]): Map<string, AssetMeta[]> {
  const index = new Map<string, AssetMeta[]>();
  for (const asset of assets) {
    if (asset.kind !== "mockup-render" || !asset.renderFp) continue;
    if (!asset.parentId || !asset.sourceMockupId) continue;
    const key = adoptionKey(asset.parentId, asset.sourceMockupId);
    const bucket = index.get(key);
    if (bucket) bucket.push(asset);
    else index.set(key, [asset]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.createdAt - a.createdAt);
  }
  return index;
}

/** The newest indexed render asset whose fingerprint matches, or null. */
export function matchInAdoptionIndex(
  index: Map<string, AssetMeta[]>,
  artworkAssetId: string,
  mockupId: string,
  fingerprint: string,
): AssetMeta | null {
  const bucket = index.get(adoptionKey(artworkAssetId, mockupId));
  return bucket?.find((asset) => asset.renderFp === fingerprint) ?? null;
}

/**
 * The on-demand form of the same match, for the render loop: queries the
 * asset table by `parentId` (an indexed field), filters to renders of THIS
 * mockup whose recorded fingerprint matches, and prefers the newest.
 */
export async function findAdoptableRender(params: {
  artworkAssetId: string;
  mockupId: string;
  fingerprint: string;
}): Promise<AssetMeta | null> {
  const candidates = await db.assets
    .where("parentId")
    .equals(params.artworkAssetId)
    .filter(
      (asset) =>
        asset.kind === "mockup-render" &&
        asset.sourceMockupId === params.mockupId &&
        asset.renderFp === params.fingerprint,
    )
    .toArray();
  return candidates.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** The session bookkeeping entry an adopted render is recorded under. */
export function adoptedRenderEntry(params: {
  asset: AssetMeta;
  fingerprint: string;
  designId: string;
  mockupId: string;
  source?: "mockups" | "listing";
}): StudioListingRender {
  return {
    assetId: params.asset.id,
    fingerprint: params.fingerprint,
    designId: params.designId,
    mockupId: params.mockupId,
    renderedAt: params.asset.createdAt,
    source: params.source ?? "mockups",
  };
}

// ---------------------------------------------------------------------------
// Linking renders that predate the fingerprint.
// ---------------------------------------------------------------------------

/**
 * Groups EVERY saved render by the pair it was rendered from, newest first.
 *
 * Unlike `buildAdoptionIndex` this keeps assets with no `renderFp`: the point
 * is to find pixels the user already saved, not to prove what made them. The
 * newest-first order is what makes "the latest saved render" deterministic.
 */
export function buildSavedRenderIndex(assets: AssetMeta[]): Map<string, AssetMeta[]> {
  const index = new Map<string, AssetMeta[]>();
  for (const asset of assets) {
    if (asset.kind !== "mockup-render") continue;
    if (!asset.parentId || !asset.sourceMockupId) continue;
    const key = adoptionKey(asset.parentId, asset.sourceMockupId);
    const bucket = index.get(key);
    if (bucket) bucket.push(asset);
    else index.set(key, [asset]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.createdAt - a.createdAt);
  }
  return index;
}

/** The newest saved render of the pair, whatever fingerprint it carries. */
export function latestSavedRenderIn(
  index: Map<string, AssetMeta[]>,
  artworkAssetId: string,
  mockupId: string,
): AssetMeta | null {
  return index.get(adoptionKey(artworkAssetId, mockupId))?.[0] ?? null;
}

/**
 * The on-demand form of `latestSavedRenderIn`, for a caller that does not hold
 * the live asset list.
 */
export async function findLatestSavedRender(params: {
  artworkAssetId: string;
  mockupId: string;
}): Promise<AssetMeta | null> {
  const candidates = await db.assets
    .where("parentId")
    .equals(params.artworkAssetId)
    .filter(
      (asset) =>
        asset.kind === "mockup-render" &&
        asset.sourceMockupId === params.mockupId,
    )
    .toArray();
  return candidates.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** One tile the "link saved renders" button can act on. */
export interface LinkableRenderTarget {
  /** The session key the entry is written under (`<listingId>:<mockupId>`). */
  key: string;
  artworkAssetId: string;
  designId: string;
  mockupId: string;
  /** The fingerprint the listing would render NOW. */
  fingerprint: string;
  /**
   * A current session render or a fingerprint-matched adopted asset already
   * covers this tile, so linking would only overwrite something fresher.
   */
  covered: boolean;
}

/**
 * The session entries an explicit "link saved renders" click writes.
 *
 * Each entry records the NEWEST saved asset of the pair under the CURRENT
 * fingerprint. That is the deliberate trade: the pixels are pinned to what the
 * user saved, and the listing stops asking for a re-render. It is only honest
 * because the click is explicit and the dialog says the assumption out loud.
 * Tiles that already have current pixels are skipped.
 */
export function linkSavedRenderEntries(
  index: Map<string, AssetMeta[]>,
  targets: LinkableRenderTarget[],
): Record<string, StudioListingRender> {
  const entries: Record<string, StudioListingRender> = {};
  for (const target of targets) {
    if (target.covered) continue;
    const asset = latestSavedRenderIn(index, target.artworkAssetId, target.mockupId);
    if (!asset) continue;
    entries[target.key] = adoptedRenderEntry({
      asset,
      fingerprint: target.fingerprint,
      designId: target.designId,
      mockupId: target.mockupId,
    });
  }
  return entries;
}
