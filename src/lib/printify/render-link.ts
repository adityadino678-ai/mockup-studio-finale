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
// A pair is ONE listing, and BOTH members' artwork matters now: the merged
// strip covers every member design, so a render saved on any member links
// under that member's own design key instead of being refused.
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
  // PAIRS: both halves' artwork matters now. The listing's tiles cover every
  // member design, so a render saved on ANY member links under that member's
  // own key (`<memberDesignId>:<mockupId>`) - the white half of an ink pair
  // and the back half of a design pair are no longer refused, because their
  // pixels are exactly what the merged strip shows.
  const isPair = listing.memberIds.length === 2 && Boolean(listing.partnerDesignId);
  if (isPair && !listing.memberIds.includes(params.designId)) {
    return { status: "not-in-batch" };
  }
  if (!isPair && listing.partnerDesignId === params.designId) {
    // Unreachable today (a single-design listing has no partner), kept as a
    // guard: never attach a foreign design's pixels to a listing.
    return { status: "white-half", listing };
  }
  // The render is keyed by the design whose artwork was rendered. For an
  // ordinary listing that is the owner; for a pair it is the member that was
  // rendered on screen.
  const renderDesignId = isPair ? params.designId : listing.designId;
  // The selection of a pair listing holds TILE ids (`<designId>:<mockupId>`)
  // so each half can be included or removed on its own; an ordinary
  // listing's selection holds plain mockup ids.
  const tileId = isPair ? `${renderDesignId}:${params.mockupId}` : params.mockupId;

  const entry: StudioListingRender = {
    assetId: params.assetId,
    fingerprint: params.fingerprint,
    designId: renderDesignId,
    mockupId: params.mockupId,
    renderedAt: params.renderedAt ?? Date.now(),
    source: "mockups",
  };

  const listingRenders = {
    ...(params.session.listingRenders ?? {}),
    [`${renderDesignId}:${params.mockupId}`]: entry,
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
      [listing.listingId]: existing.includes(tileId) ? existing : [...existing, tileId],
    };
  } else if (params.session.listingImageCleared?.[listing.listingId] === true) {
    listingImages = {
      ...(params.session.listingImages ?? {}),
      [listing.listingId]: [tileId],
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
