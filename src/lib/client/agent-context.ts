"use client";

// ---------------------------------------------------------------------------
// Agent surface context.
//
// The panel is mounted in the app shell, so it lives OUTSIDE the page view's
// React tree. It therefore cannot read the view's props. This module is the
// bridge: each page publishes a small, plain description of what the user is
// looking at, and the agent prompt is built from that.
//
// Nothing here is a second source of truth. It reads the same session and
// drafts the page reads, and it is refreshed on every turn, so the agent
// always describes the CURRENT state rather than the state when the panel
// opened.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db/schema";
import { loadSession } from "@/lib/printify/studio-session";
import { buildStudioListings } from "@/lib/printify/listing-plan";
import { categoryFor, loadCachedBlueprints } from "@/lib/printify/catalog-client";
import type { Design, StudioSession } from "@/types/domain";

export type AgentSurface = "listing" | "studio";

export interface SurfaceContext {
  surface: AgentSurface;
  /** The listing the user is looking at, when one is known. */
  listingName?: string;
  /** How many listings the batch holds. */
  listingCount?: number;
  /** The product the batch is built on, e.g. "Gildan 5000". */
  productName?: string;
  /** The mockup / product type, e.g. "t-shirt". */
  mockupType?: string;
  /** Number of designs in the library. */
  designCount?: number;
  /** Number of product mockups in the library (info cards excluded). */
  mockupCount?: number;
}

/**
 * The text injected into the agent's system prompt.
 *
 * It is deliberately short: the agent reads the real data with its tools, so
 * this only says WHERE it is and what the user is working on.
 */
export function describeSurface(context: SurfaceContext): string {
  const lines: string[] = [];
  if (context.surface === "listing") {
    lines.push("You are the LISTING agent. You are on the Listing details page.");
    lines.push("Your job: write and save Etsy listing copy for the user's designs.");
  } else {
    lines.push("You are the STUDIO agent. You are on the Printify Studio page.");
    lines.push("Your job: generate images for the user's designs.");
  }
  if (context.listingName) lines.push(`The listing currently open is “${context.listingName}”.`);
  if (context.listingCount !== undefined) {
    lines.push(`The batch holds ${context.listingCount} listing${context.listingCount === 1 ? "" : "s"}.`);
  }
  if (context.productName) lines.push(`The product is ${context.productName}.`);
  if (context.mockupType) lines.push(`The mockup / product type is ${context.mockupType}.`);
  if (context.designCount !== undefined) {
    lines.push(`The library holds ${context.designCount} design${context.designCount === 1 ? "" : "s"}.`);
  }
  return lines.join("\n");
}

/**
 * Reads the live workspace state for a surface.
 *
 * The product name comes from the cached catalogue when it is available, so
 * the agent can say "Gildan 5000" instead of "blueprint 12" — but it never
 * fails when the catalogue is not cached: the ids are still reported.
 */
export async function readSurfaceContext(
  surface: AgentSurface,
  listingName?: string,
): Promise<SurfaceContext> {
  const [session, designs, mockups] = await Promise.all([
    loadSession(),
    db.designs.toArray(),
    db.mockups.toArray(),
  ]);
  const context: SurfaceContext = {
    surface,
    designCount: designs.length,
    mockupCount: mockups.filter((m) => m.kind !== "info-card").length,
  };

  if (surface === "listing") {
    const listings = buildStudioListings(designs as Design[], session);
    context.listingCount = listings.length;
    if (listingName) context.listingName = listingName;
    else if (listings.length === 1) context.listingName = listings[0].designName;
  }

  const productName = await productNameFor(session);
  if (productName) {
    context.productName = productName.title;
    context.mockupType = mockupTypeFromTitle(productName.title) ?? productName.category;
  }

  return context;
}

/** The catalogue entry for the session's blueprint, when it is cached. */
async function productNameFor(
  session: StudioSession,
): Promise<{ title: string; category: string } | undefined> {
  if (!session.blueprintId) return undefined;
  try {
    const blueprints = await loadCachedBlueprints();
    const found = blueprints?.find((b) => b.id === session.blueprintId);
    if (found) return { title: found.title ?? `blueprint ${found.id}`, category: categoryFor(found) };
  } catch {
    /* the catalogue is optional */
  }
  return { title: `blueprint ${session.blueprintId}`, category: "Other" };
}

// ---------------------------------------------------------------------------
// The active-listing channel
//
// The panel is mounted in the app shell, outside the page view, so it cannot
// read the page's React state. The page publishes the listing it has open
// here, and the panel reads it. It is a one-way channel on purpose: the page
// never reads anything back, so the panel can never change what the page
// shows.
// ---------------------------------------------------------------------------

export interface ActiveListing {
  listingId: string;
  designName: string;
}

let activeListing: ActiveListing | undefined;
const listingListeners = new Set<(listing: ActiveListing | undefined) => void>();

/** Called by the Listing details page when the open listing changes. */
export function publishActiveListing(listing: ActiveListing | undefined): void {
  activeListing = listing;
  for (const listener of listingListeners) listener(listing);
}

/** The listing the user currently has open, if the page told us. */
export function currentActiveListing(): ActiveListing | undefined {
  return activeListing;
}

/** Subscribes to the active listing. Returns an unsubscribe function. */
export function onActiveListing(listener: (listing: ActiveListing | undefined) => void): () => void {
  listingListeners.add(listener);
  return () => listingListeners.delete(listener);
}

/**
 * The mockup type for a product, derived from the catalogue title.
 *
 * "Gildan 5000" tells the agent nothing about the garment; "t-shirt" does.
 */
export function mockupTypeFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const lower = title.toLowerCase();
  const types = [
    "t-shirt",
    "tshirt",
    "tank",
    "hoodie",
    "sweatshirt",
    "mug",
    "poster",
    "tote",
    "sticker",
    "phone case",
    "notebook",
    "blanket",
    "pillow",
    "canvas",
    "hat",
    "cap",
    "leggings",
  ];
  for (const type of types) {
    if (lower.includes(type)) return type;
  }
  return undefined;
}
