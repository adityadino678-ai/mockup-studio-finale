// ---------------------------------------------------------------------------
// The "already applied" guard for a listing's Printify mockups.
//
// Send has two jobs that used to be inseparable: update the product's copy and
// price, and upload/apply its mockup selection. The first is cheap; the second
// re-renders, re-uploads and rewrites Printify's selection. Editing a title or
// a price must not pay for the second job when the images have not changed.
//
// The signature below is the one thing that decides. It covers the product the
// images belong to, the selected mockups in display order, and each render's
// fingerprint (the design, mockup, print area, placement and compositing
// inputs). A changed image, a changed order or a different product produces a
// different signature; nothing else does, so the guard cannot be fooled by a
// re-render that produced identical pixels.
//
// It is deliberately a pure module: the preview, Listing images and the tests
// all compute the same value.
// ---------------------------------------------------------------------------

import type { StudioListingMockupsApplied, StudioSession } from "@/types/domain";

/** One image in the applied selection, in display order. */
export interface AppliedListingImage {
  mockupId: string;
  /** The render fingerprint whose pixels were uploaded. */
  fingerprint: string;
}

/**
 * A stable signature of "these exact images, in this order, for this product".
 *
 * JSON is used rather than a short hash on purpose: a collision here would
 * silently skip an image update, and the string is small enough to keep in the
 * local session.
 */
export function listingMockupSignature(
  productId: string,
  images: AppliedListingImage[],
): string {
  return JSON.stringify({
    v: 1,
    productId,
    images: images.map((image) => [image.mockupId, image.fingerprint]),
  });
}

/** The record to persist after a successful apply. */
export function appliedMockupRecord(
  productId: string,
  images: AppliedListingImage[],
  at = Date.now(),
): StudioListingMockupsApplied {
  return {
    productId,
    signature: listingMockupSignature(productId, images),
    appliedAt: at,
  };
}

/**
 * True when the session proves this exact selection was applied to this
 * product. A missing record is false: the safe path is to upload once.
 */
export function mockupsAlreadyApplied(
  session: StudioSession,
  listingId: string,
  productId: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const applied = session.listingMockupsApplied?.[listingId];
  return Boolean(
    applied && applied.productId === productId && applied.signature === signature,
  );
}

/** Merge new records into the session's existing applied map. */
export function withAppliedMockups(
  session: StudioSession,
  records: Record<string, StudioListingMockupsApplied>,
): StudioSession {
  if (Object.keys(records).length === 0) return session;
  return {
    ...session,
    listingMockupsApplied: {
      ...(session.listingMockupsApplied ?? {}),
      ...records,
    },
    updatedAt: Date.now(),
  };
}
