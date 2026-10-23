// ---------------------------------------------------------------------------
// Writing the Studio's local listing drafts.
//
// The Printify product and the local listing draft are two halves of one
// listing: the product carries the artwork, the draft carries the copy, tags,
// price and the selected images for the Export Center. Saving them together
// keeps the two from disagreeing when the user edits the Listing tabs.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db/schema";
import { getPlacement, uid, logActivity } from "@/lib/db/repo";
import {
  listingMockupIds,
  listingRenderFor,
  parseTags,
  placementFor,
  priceForListing,
  renderTemplate,
  renderTitle,
} from "@/lib/printify/studio-session";
import { listingImageFingerprint } from "@/lib/printify/listing-render";
import type { StudioListing } from "@/lib/printify/listing-plan";
import type { ListingDraft, StudioSession } from "@/types/domain";

export interface SaveListingDraftsResult {
  created: number;
  updated: number;
  saved: number;
}

export interface ListingImageState {
  imageAssetIds: string[];
  imageSelectionLocked?: boolean;
}

/**
 * Decides what an image selection means for the Export Center.
 *
 * An empty selection is ambiguous, so it is never treated as a clear on its
 * own: without `explicitClear` it preserves the previous state. A partially
 * rendered selection also preserves the previous state, because locking the
 * rendered subset would silently drop the rest. Only a complete, fresh
 * selection replaces the locked order.
 */
export function nextListingImageState(params: {
  selectedCount: number;
  renderedIds: string[];
  existing?: Pick<ListingDraft, "imageAssetIds" | "imageSelectionLocked"> | null;
  explicitClear: boolean;
  lockSelection: boolean;
}): ListingImageState {
  const existing = params.existing;
  if (params.explicitClear) {
    return { imageAssetIds: [], imageSelectionLocked: true };
  }

  const fullSelection =
    params.selectedCount > 0 && params.renderedIds.length === params.selectedCount;
  if (fullSelection) {
    return {
      imageAssetIds: params.renderedIds,
      imageSelectionLocked:
        params.lockSelection || existing?.imageSelectionLocked ? true : undefined,
    };
  }

  return {
    imageAssetIds: existing?.imageAssetIds ?? [],
    imageSelectionLocked: existing?.imageSelectionLocked,
  };
}

/**
 * Saves one draft per listing, in listing order.
 *
 * `imageAssetIds` is built from the selected mockups and their cached renders,
 * in click order. Missing render assets are dropped, so a draft can never point
 * the ZIP export at an asset that is no longer in IndexedDB.
 */
export async function saveStudioListingDrafts(params: {
  session: StudioSession;
  listings: StudioListing[];
  productName: string;
  /**
   * Whether this save is the user's explicit image selection.
   *
   * Product creation saves drafts too, and before the Listing images tab has
   * been used it must not lock an empty selection: that would make the Export
   * Center silently drop every render. An existing locked selection always
   * stays locked.
   */
  lockSelection?: boolean;
}): Promise<SaveListingDraftsResult> {
  const { session, listings, productName } = params;
  const lockSelection = params.lockSelection ?? true;
  const now = Date.now();
  let created = 0;
  let updated = 0;

  for (const listing of listings) {
    const selected = listingMockupIds(session, listing.listingId);
    const mockupRows = await db.mockups.bulkGet(selected);
    const savedPlacements = await Promise.all(
      selected.map((mockupId) => getPlacement(listing.designId, mockupId)),
    );
    const placement = placementFor(session, listing.designId);

    // Recompute the fingerprint rather than trusting the stored entry. A
    // placement/artwork/mockup change between render and save must not lock
    // obsolete pixels into the Export Center.
    const freshRenders = selected
      .map((mockupId, index) => {
        const entry = listingRenderFor(session, listing.listingId, mockupId);
        const mockup = mockupRows[index];
        if (!entry || !mockup) return null;
        const fingerprint = listingImageFingerprint({
          listing,
          mockup,
          placement,
          saved: savedPlacements[index],
        });
        return entry.fingerprint === fingerprint ? entry : null;
      })
      .filter((render): render is NonNullable<typeof render> => !!render);
    const metas = await db.assets.bulkGet(freshRenders.map((render) => render.assetId));
    const renderedIds = freshRenders
      .filter((_, index) => Boolean(metas[index]))
      .map((render) => render.assetId);

    const draftRows = await db.listingDrafts
      .where("designId")
      .equals(listing.listingId)
      .toArray();
    const existing = draftRows.sort((a, b) => a.updatedAt - b.updatedAt)[draftRows.length - 1];

    const imageState = nextListingImageState({
      selectedCount: selected.length,
      renderedIds,
      existing,
      explicitClear: session.listingImageCleared?.[listing.listingId] === true,
      lockSelection,
    });

    const products = await db.productDrafts.where("designId").equals(listing.listingId).toArray();
    const product = products.sort((a, b) => b.createdAt - a.createdAt)[0];

    const title = renderTitle(session.titleTemplate, listing.designName, productName);
    const draft: ListingDraft = {
      id: existing?.id ?? uid(),
      title,
      description: renderTemplate(
        session.descriptionTemplate,
        listing.designName,
        productName,
        "",
        5000,
      ),
      tags: parseTags(session.tags),
      category: session.category?.trim() || undefined,
      priceCents: priceForListing(session, listing.listingId),
      quantity: session.quantity && session.quantity > 0 ? Math.round(session.quantity) : 1,
      productDraftId: product?.id ?? existing?.productDraftId,
      designId: listing.listingId,
      imageAssetIds: imageState.imageAssetIds,
      imageSelectionLocked: imageState.imageSelectionLocked,
      status: existing?.status ?? "local-draft",
      error: existing?.error,
      remoteListingId: existing?.remoteListingId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await db.listingDrafts.put(draft);
    if (existing) updated++;
    else created++;
  }

  if (created + updated > 0) {
    await logActivity(
      "design.update",
      `Saved ${created + updated} listing draft${created + updated === 1 ? "" : "s"} from the Studio`,
    );
  }

  return { created, updated, saved: created + updated };
}

/**
 * Re-points a listing's local draft when the user swaps the pair's black/white
 * halves. The old white half's draft is discarded: it was never a listing.
 */
export async function remapListingDraftOwner(
  fromId: string,
  toId: string,
): Promise<void> {
  if (!fromId || !toId || fromId === toId) return;
  const [fromRows, toRows] = await Promise.all([
    db.listingDrafts.where("designId").equals(fromId).toArray(),
    db.listingDrafts.where("designId").equals(toId).toArray(),
  ]);
  for (const row of toRows) await db.listingDrafts.delete(row.id);
  for (const row of fromRows) {
    await db.listingDrafts.put({ ...row, designId: toId, updatedAt: Date.now() });
  }
}
