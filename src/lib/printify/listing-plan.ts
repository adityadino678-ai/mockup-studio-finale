// ---------------------------------------------------------------------------
// The listings a studio session will create.
//
// This is the ONE answer to "what is a listing?" used by the Listing images and
// Listing details tabs. It deliberately follows the Design panel's rules:
//
//   * only ticked designs are in scope;
//   * a pair is ONE listing, owned by its black-ink half;
//   * a half-pair is not a pair, so it stays an ordinary design;
//   * a design in no pair is in the row its "Ink variants" tick names.
//
// It carries no artwork/colour planning: the Design panel still owns the
// print partition. This module only decides the listing identity and order, so
// the tabs can attach images, copy and prices to the same listing the product
// loop creates.
// ---------------------------------------------------------------------------

import type { Design, StudioSession } from "@/types/domain";

export type StudioListingRow = "plain" | "ink";

export interface StudioListing {
  /** The owner: the black-ink half of a pair, or the design itself. */
  listingId: string;
  designId: string;
  designName: string;
  row: StudioListingRow;
  /** Every design that contributes artwork to this listing. */
  memberIds: string[];
  partnerDesignId?: string;
  partnerName?: string;
  /** The artwork used for the listing image previews and renders. */
  artworkAssetId: string;
  /**
   * Per-member main artwork, present only for a pair listing (memberIds
   * length 2): the strip renders BOTH designs' tiles, and each tile needs
   * its own design's artwork and print-area context. Ordinary listings
   * leave this unset - their tiles read `artworkAssetId`.
   */
  memberArtworkIds?: Record<string, string>;
}

type ListingDesign = Pick<
  Design,
  "id" | "name" | "originalAssetId" | "processedAssetId"
> &
  Partial<Pick<Design, "whiteInkAssetId" | "blackInkAssetId" | "createdAt">>;

function mainAssetId(design: ListingDesign): string {
  return design.processedAssetId ?? design.originalAssetId;
}

/**
 * Builds one entry per listing, in the gallery's design order.
 *
 * Empty `designIds` means no listings - matching the Design panel, where an
 * empty tick list means NO batch rather than "every design".
 */
export function buildStudioListings(
  designs: ListingDesign[],
  session: StudioSession,
): StudioListing[] {
  const byId = new Map(designs.map((design) => [design.id, design]));
  const scoped = new Set(session.designIds);
  const inkTicks = new Set(session.inkPairIds ?? []);
  const handled = new Set<string>();
  const listings: StudioListing[] = [];
  const ordered = [...designs].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );

  for (const design of ordered) {
    if (handled.has(design.id) || !scoped.has(design.id)) continue;

    const pair = (session.inkPairs ?? []).find(
      (candidate) =>
        candidate.blackInkDesignId === design.id ||
        candidate.whiteInkDesignId === design.id,
    );
    if (pair) {
      const black = byId.get(pair.blackInkDesignId);
      const white = byId.get(pair.whiteInkDesignId);
      // Emit the pair at the black owner's slot, never at whichever half
      // happens to sort first. If the black half is not in scope, the white
      // half falls through as an ordinary design.
      if (
        design.id === pair.whiteInkDesignId &&
        black &&
        scoped.has(black.id) &&
        !handled.has(black.id)
      ) {
        continue;
      }
      // Both halves must be ticked and present. A half-pair is left as two
      // ordinary designs instead of being guessed at.
      if (
        black &&
        white &&
        scoped.has(black.id) &&
        scoped.has(white.id) &&
        !handled.has(black.id) &&
        !handled.has(white.id)
      ) {
        handled.add(black.id);
        handled.add(white.id);
        listings.push({
          listingId: black.id,
          designId: black.id,
          designName: black.name,
          row: "ink",
          memberIds: [black.id, white.id],
          partnerDesignId: white.id,
          partnerName: white.name,
          artworkAssetId: mainAssetId(black),
          memberArtworkIds: {
            [black.id]: mainAssetId(black),
            [white.id]: mainAssetId(white),
          },
        });
        continue;
      }
    }

    // A DESIGN pair is also ONE listing, owned by its front half, covering
    // BOTH designs' artwork. Entirely separate from ink pairs: it prints the
    // plain panel's colours, front design on the front print area, back
    // design on the back. Emitted at the front half's slot, like ink pairs.
    const designPair = (session.designPairs ?? []).find(
      (candidate) =>
        candidate.frontDesignId === design.id || candidate.backDesignId === design.id,
    );
    if (designPair) {
      const front = byId.get(designPair.frontDesignId);
      const back = byId.get(designPair.backDesignId);
      if (
        design.id === designPair.backDesignId &&
        front &&
        scoped.has(front.id) &&
        !handled.has(front.id)
      ) {
        continue;
      }
      if (
        front &&
        back &&
        scoped.has(front.id) &&
        scoped.has(back.id) &&
        !handled.has(front.id) &&
        !handled.has(back.id)
      ) {
        handled.add(front.id);
        handled.add(back.id);
        listings.push({
          listingId: front.id,
          designId: front.id,
          designName: front.name,
          row: "plain",
          memberIds: [front.id, back.id],
          partnerDesignId: back.id,
          partnerName: back.name,
          artworkAssetId: mainAssetId(front),
          memberArtworkIds: {
            [front.id]: mainAssetId(front),
            [back.id]: mainAssetId(back),
          },
        });
        continue;
      }
    }

    handled.add(design.id);
    listings.push({
      listingId: design.id,
      designId: design.id,
      designName: design.name,
      row:
        inkTicks.has(design.id) &&
        Boolean(design.whiteInkAssetId || design.blackInkAssetId)
          ? "ink"
          : "plain",
      memberIds: [design.id],
      artworkAssetId: mainAssetId(design),
    });
  }

  return listings;
}

/** The two rows the Listing images tab draws. */
export function groupStudioListings(listings: StudioListing[]): {
  plain: StudioListing[];
  ink: StudioListing[];
} {
  return {
    plain: listings.filter((listing) => listing.row === "plain"),
    ink: listings.filter((listing) => listing.row === "ink"),
  };
}

/**
 * True when a listing is a pair (either kind): two designs, one listing.
 */
export function isPairListing(
  listing: Pick<StudioListing, "memberIds" | "memberArtworkIds">,
): boolean {
  return listing.memberIds.length === 2 && Boolean(listing.memberArtworkIds);
}

/**
 * The stored selection ids for a listing, with one repair applied:
 *
 * A listing that was CONFIGURED before its pair existed holds BARE mockup
 * ids (an ordinary listing's shape). Read as-is, a pair's tile filter drops
 * every one of them - the row collapses to an empty selection, all of its
 * tiles draw as excluded, and the bare mockup photo shows instead of the
 * design (the owner's report). So a pair's bare ids EXPAND to both members'
 * tiles, in member order, keeping the user's include/exclude decision and
 * the stored order. Proper tile ids pass through; a tile id naming a design
 * that is no longer a member is dropped, exactly as the callers' validity
 * filter would drop it.
 */
export function listingSelectionIds(
  session: StudioSession,
  listing: Pick<StudioListing, "listingId" | "memberIds" | "memberArtworkIds">,
): string[] {
  const stored = session.listingImages?.[listing.listingId];
  if (!stored) return [];
  if (!isPairListing(listing)) return stored;
  const members = new Set(listing.memberIds);
  return stored.flatMap((id) => {
    const sep = id.indexOf(":");
    if (sep > 0) return members.has(id.slice(0, sep)) ? [id] : [];
    // A bare mockup id from before the pairing existed: both halves inherit it.
    return listing.memberIds.map((memberId) => `${memberId}:${id}`);
  });
}

/** The Printify product title for a blueprint, for `{product}` expansion. */
export function catalogProductName(
  blueprints: Array<{ id: number; title: string }>,
  blueprintId?: number,
): string {
  return (
    blueprints.find((blueprint) => blueprint.id === blueprintId)?.title ??
    "Printify product"
  );
}
