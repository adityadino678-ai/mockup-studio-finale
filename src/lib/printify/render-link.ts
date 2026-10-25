// ---------------------------------------------------------------------------
// Attaching a render saved in Mockups to the listing it belongs to.
//
// Saving pixels used to be only half the job: the asset existed, but the
// session did not point at it, so Listing images still showed "Not rendered"
// and the next Save & render produced a different composition. This module
// makes "Save render" mean "save AND use": it finds the owning listing, writes
// the render under that listing's current fingerprint, and makes sure the
// mockup is part of the listing's image selection.
//
// A pair is ONE listing owned by its black-ink half. Saving on the white half
// would attach the wrong artwork to the listing, so that case is blocked with
// an explanation instead of silently doing the wrong thing.
// ---------------------------------------------------------------------------

import type {
  Design,
  StudioListingRender,
  StudioSession,
} from "@/types/domain";
import {
  buildStudioListings,
  type StudioListing,
} from "@/lib/printify/listing-plan";

export type SavedRenderLink =
  | {
      status: "linked";
      listing: StudioListing;
      entry: StudioListingRender;
      /** The session fields the caller should persist. */
      patch: Partial<
        Pick<
          StudioSession,
          "listingImages" | "listingImageCleared" | "listingRenders"
        >
      >;
    }
  | {
      status: "white-half";
      /** The pair listing whose artwork is the black half. */
      listing: StudioListing;
    }
  | { status: "not-in-batch" };

/**
 * The session patch that makes one saved render the listing's current image.
 *
 * Selection rules match Listing images exactly:
 *   * an explicit list is extended, preserving order;
 *   * an explicit Clear becomes this one image;
 *   * a never-configured listing keeps the default "every mockup" selection,
 *     which already includes the saved mockup.
 */
export function linkSavedRender(params: {
  designId: string;
  mockupId: string;
  assetId: string;
  fingerprint: string;
  session: StudioSession;
  designs: Design[];
  renderedAt?: number;
}): SavedRenderLink {
  const listings = buildStudioListings(params.designs, params.session);
  const listing = listings.find(
    (candidate) =>
      candidate.designId === params.designId ||
      candidate.memberIds.includes(params.designId),
  );

  if (!listing) return { status: "not-in-batch" };
  if (listing.partnerDesignId === params.designId) {
    return { status: "white-half", listing };
  }

  const entry: StudioListingRender = {
    assetId: params.assetId,
    fingerprint: params.fingerprint,
    designId: listing.designId,
    mockupId: params.mockupId,
    renderedAt: params.renderedAt ?? Date.now(),
    source: "mockups",
  };

  const listingRenders = {
    ...(params.session.listingRenders ?? {}),
    [`${listing.listingId}:${params.mockupId}`]: entry,
  };
  const listingImageCleared = { ...(params.session.listingImageCleared ?? {}) };
  delete listingImageCleared[listing.listingId];

  // Only touch the selection when there is something to change. A listing that
  // was never configured already includes every mockup, so writing an explicit
  // list here would silently pin a changing library.
  const existing = params.session.listingImages?.[listing.listingId];
  let listingImages: Record<string, string[]> | undefined;
  if (existing !== undefined) {
    listingImages = {
      ...(params.session.listingImages ?? {}),
      [listing.listingId]: existing.includes(params.mockupId)
        ? existing
        : [...existing, params.mockupId],
    };
  } else if (params.session.listingImageCleared?.[listing.listingId] === true) {
    listingImages = {
      ...(params.session.listingImages ?? {}),
      [listing.listingId]: [params.mockupId],
    };
  }

  return {
    status: "linked",
    listing,
    entry,
    patch: {
      listingRenders,
      listingImageCleared,
      ...(listingImages ? { listingImages } : {}),
    },
  };
}
