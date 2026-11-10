"use client";

// ---------------------------------------------------------------------------
// Listing images.
//
// One row PER DESIGN (or per pair), and one tile per mockup in that row. The
// page picks nothing for you to choose: every design in the batch is on screen
// at once, oldest first, and every mockup is a tile. A design that was never
// configured starts with EVERY mockup included, so the page is a review
// surface, not a checklist that starts empty.
//
// The ticks are the listing's images, in order: the first included tile is the
// main image. Long-pressing a tile starts a removal set for that row - the
// marked mockups never go to Printify because they are removed from the
// selection - and a single click adds or removes more while that set is open.
//
// A tile shows the render SAVED in the Mockups panel when one exists whose
// recorded fingerprint matches what this listing would render now (see
// render-adoption.ts). Missing renders are shown honestly as "not rendered"
// and are produced by Save & render, which also writes the local listing
// drafts the Export Center reads.
//
// This used to be a Studio tab and received its session from the Studio page.
// It is a page of its own now, so it loads the session itself - live, like
// the Mockups panel, because the Studio and the agent write the same blob -
// and persists each patch by merging it over the LATEST stored session. Only
// the fields this view touched may change: saving the whole local copy would
// silently put a value written elsewhere (a placement, a colour selection)
// back to what this page last saw.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { Reorder, useDragControls } from "framer-motion";
import { zip, type Zippable } from "fflate";
import { db, getSetting } from "@/lib/db/schema";
import { getAssetBlob, logActivity } from "@/lib/db/repo";
import { authedFetch } from "@/lib/client/integrations";
import { mockupImageForUpload } from "@/lib/client/mockup-upload";
import { Link, navigate } from "@/lib/client/nav";
import {
  extensionOutdated,
  extensionReady as companionExtensionReady,
  extensionReloadMessage,
} from "@/lib/client/extension";
import { AssetThumb } from "@/components/asset-thumb";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildStudioListings,
  catalogProductName,
  groupStudioListings,
  type StudioListing,
} from "@/lib/printify/listing-plan";
import {
  applyGlobalOrder,
  listingMockupIds,
  listingRenderFor,
  mergeGlobalOrder,
  mergeOwnOrder,
  orderedIdsForListing,
  placementFor,
  RESULTS_KEY,
  ROW_HINTS,
  ROW_LABELS,
} from "@/lib/printify/studio-session";
import {
  isListingRenderFresh,
  listingImageFingerprint,
  listingRenderKey,
  renderListingMockup,
} from "@/lib/printify/listing-render";
import { saveStudioListingDrafts } from "@/lib/printify/listing-drafts";
import { appliedMockupRecord } from "@/lib/printify/listing-mockups";
import {
  bridgePayloadJson,
  buildBridgePayload,
  countBridgeImages,
  type PrintifyBridgePayload,
  type PrintifyBridgeProduct,
  type PrintifyMockupUpload,
} from "@/lib/printify/mockup-bridge";
import {
  emptySession,
  loadSession,
  saveSession,
} from "@/lib/printify/studio-session";
import { printAreaOf } from "@/lib/mockups/print-area";
import {
  infoCardsForListing,
  isProductMockup,
  productMockups,
} from "@/lib/mockups/info-cards";
import { useListingCatalog } from "@/views/listings/listing-catalog";
import {
  adoptedRenderEntry,
  buildAdoptionIndex,
  buildSavedRenderIndex,
  linkSavedRenderEntries,
  matchInAdoptionIndex,
  type LinkableRenderTarget,
} from "@/views/listings/render-adoption";
import type {
  AssetMeta,
  Design,
  Mockup,
  Placement,
  StudioListingMockupsApplied,
  StudioListingRender,
  StudioProductResult,
  StudioSession,
} from "@/types/domain";
import {
  Check,
  Download,
  ExternalLink,
  GripVertical,
  Images,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";

interface SelectedImage {
  mockup: Mockup;
  entry: StudioListingRender | undefined;
  /** The session entry is current. */
  fresh: boolean;
  /** The user has forced this tile to use its saved Mockups render. */
  overridden: boolean;
  /**
   * A saved render asset whose recorded fingerprint matches the current
   * inputs. Adopting it means "this render already shows exactly what the
   * listing would render now", so there is nothing to re-render.
   */
  adopted: StudioListingRender | undefined;
  /** What the listing would render right now for this tile. */
  fingerprint: string;
}

interface UploadResponse {
  shopId?: number;
  productId?: string;
  title?: string;
  uploads?: PrintifyMockupUpload[];
  error?: string;
}

const MAX_IMAGES_PER_UPLOAD = 8;

function safeName(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image"
  );
}

function extensionFor(blob: Blob): string {
  if (blob.type === "image/jpeg") return "jpg";
  if (blob.type === "image/webp") return "webp";
  return "png";
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function zipFiles(files: Zippable, filename: string): Promise<number> {
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)));
  });
  triggerDownload(
    new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" }),
    filename,
  );
  return Object.keys(files).length;
}

/**
 * One step of the Send flow.
 *
 * The flow is three things the user has to do once, in order, and two of them
 * already happened by the time the dialog opens. Showing that explicitly is
 * the whole point: the upload is ours, the selection is Printify's, and the
 * bookmarklet is the one click that bridges them.
 */
function SendStep({
  step,
  title,
  detail,
  done,
}: {
  step: number;
  title: string;
  detail: string;
  done: boolean;
}) {
  return (
    <li
      className={`rounded-md border px-2.5 py-2 ${
        done
          ? "border-forest/40 bg-forest-soft/30"
          : "border-border-subtle bg-surface-muted/40"
      }`}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-xs text-white ${
            done ? "bg-forest" : "bg-ink-subtle"
          }`}
        >
          {done ? <Check className="h-2.5 w-2.5" /> : step}
        </span>
        {title}
      </p>
      <p className="mt-0.5 pl-[22px] text-xs text-ink-muted">{detail}</p>
    </li>
  );
}

/**
 * One draggable tile.
 *
 * The drag starts from the HANDLE, never from the tile itself, so a plain
 * click still takes the mockup in or out of the listing. The handle is
 * handed to the caller so it can live OUTSIDE the tile's button: a button
 * inside a button is not valid HTML and the browser would swallow the click.
 */
function DraggableTile({
  value,
  label,
  disabled,
  children,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const controls = useDragControls();
  const handle = (
    <button
      type="button"
      aria-label={`Reorder ${label}`}
      disabled={disabled}
      onPointerDown={(event) => {
        // The handle is the only drag surface: a drag that started on the
        // picture would fight the click that toggles the mockup.
        event.preventDefault();
        event.stopPropagation();
        controls.start(event);
      }}
      className="flex h-6 w-6 shrink-0 cursor-grab items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink active:cursor-grabbing disabled:opacity-40"
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <Reorder.Item
      as="div"
      value={value}
      dragListener={false}
      dragControls={controls}
      className="relative w-[132px] shrink-0"
    >
      {children(handle)}
    </Reorder.Item>
  );
}

export function ListingImagesView() {
  const designs = useLiveQuery(() => db.designs.toArray(), []);
  const mockups = useLiveQuery(() => db.mockups.orderBy("createdAt").toArray(), []);
  const placements = useLiveQuery(() => db.placements.toArray(), []);
  // Every saved render, so a tile can ADOPT one whose recorded fingerprint
  // still matches the listing's current inputs instead of re-rendering it.
  const renderAssets = useLiveQuery(
    () => db.assets.where("kind").equals("mockup-render").toArray(),
    [],
  );
  const results = useLiveQuery(async () => {
    const stored = await getSetting<StudioProductResult[]>(RESULTS_KEY, []);
    return Array.isArray(stored) ? stored : [];
  }, []);
  // A "locked" listing is one whose Export Center image selection the user has
  // already fixed by hand. Replacing its images must therefore be confirmed.
  const listingDrafts = useLiveQuery(() => db.listingDrafts.toArray(), []);
  const lockedListings = React.useMemo(
    () =>
      new Set(
        (listingDrafts ?? [])
          .filter((draft) => draft.imageSelectionLocked && draft.designId)
          .map((draft) => draft.designId as string),
      ),
    [listingDrafts],
  );
  /** A pending confirmation for replacing a locked listing's images. */
  const [lockedConfirm, setLockedConfirm] = React.useState<{
    listingName: string;
    apply: () => void;
  } | null>(null);
  /** A pending confirmation for discarding a detached row's own order. */
  const [ownOrderConfirm, setOwnOrderConfirm] = React.useState<{
    listingName: string;
    apply: () => void;
  } | null>(null);
  const catalog = useListingCatalog();

  // --- session ---------------------------------------------------------------
  // Live, not one-shot: the Studio page, the Mockups panel and the agent all
  // write the same blob, and this page must see those writes without a reload.
  const liveSession = useLiveQuery(() => loadSession(), []);
  const [session, setSession] = React.useState<StudioSession>(() => emptySession());

  /**
   * Patches captured but not persisted yet.
   *
   * The echo-merge below re-applies them, and the queued write drains them,
   * so a tick can never be lost between a click and its save.
   */
  const pendingPatch = React.useRef<Partial<StudioSession>>({});
  /**
   * Writes are queued: two ticks in quick succession must not interleave
   * their read-latest/write steps, or the second write would be built from a
   * snapshot that predates the first and silently drop it.
   */
  const writeQueue = React.useRef<Promise<void>>(Promise.resolve());

  React.useEffect(() => {
    if (!liveSession) return;
    // Re-apply patches still waiting in the write queue: the echo of an
    // earlier save can land while a newer tick has not been persisted yet.
    setSession({ ...liveSession, ...pendingPatch.current });
  }, [liveSession]);

  /** Patches local state and persists the patch over the latest stored blob. */
  const update = React.useCallback((patch: Partial<StudioSession>) => {
    setSession((prev) => ({ ...prev, ...patch, updatedAt: Date.now() }));
    // Accumulate rather than replace: the patches carry whole values per key,
    // so the newest patch of a key already supersedes an older one.
    pendingPatch.current = { ...pendingPatch.current, ...patch };
    writeQueue.current = writeQueue.current.then(async () => {
      const saving = pendingPatch.current;
      pendingPatch.current = {};
      if (Object.keys(saving).length === 0) return;
      try {
        const latest = await loadSession();
        await saveSession({ ...latest, ...saving, updatedAt: Date.now() });
      } catch {
        // Put the patch back so a later write (or the next echo) can still
        // persist it; the failure is reported, not swallowed.
        pendingPatch.current = { ...saving, ...pendingPatch.current };
        toast.error("Could not save the studio session");
      }
    });
  }, []);

  const [rendering, setRendering] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0, label: "" });
  const [sending, setSending] = React.useState(false);
  const [sendProgress, setSendProgress] = React.useState({
    done: 0,
    total: 0,
    label: "",
  });
  const [bridgeOpen, setBridgeOpen] = React.useState(false);
  const [bridgePayload, setBridgePayload] = React.useState("");
  /** True once the payload is on the clipboard, so the dialog can say so. */
  const [bridgeCopied, setBridgeCopied] = React.useState(false);
  const [bridgeSummary, setBridgeSummary] = React.useState<{
    products: number;
    images: number;
    failures: string[];
    skipped: string[];
    firstProductId?: string;
  } | null>(null);
  /** The structured payload object the extension needs (the string is for the clipboard). */
  const [bridgePayloadData, setBridgePayloadData] =
    React.useState<PrintifyBridgePayload | null>(null);
  /**
   * True when the "Mockup Studio Printify Bridge" extension is installed and
   * loaded in this browser tab. It marks the page (see extension/protocol.md);
   * when it is absent the app keeps the clipboard + bookmarklet path.
   */
  const [extensionReady, setExtensionReady] = React.useState(false);
  /** An old build is present but merges instead of replacing, so it is not used. */
  const [extensionOld, setExtensionOld] = React.useState(false);
  /** True while the extension is applying the selection inside Printify. */
  const [extensionApplying, setExtensionApplying] = React.useState(false);
  /**
   * The local "the mockups were applied" done state. Set from the extension's
   * answer; it means Printify now has these selected for the products.
   */
  const [bridgeApplied, setBridgeApplied] = React.useState<{
    done: number;
    total: number;
    failures: string[];
  } | null>(null);
  /** The request id of the apply currently in flight, so a late answer is matched. */
  const applyRequestId = React.useRef<string | null>(null);

  /**
   * Tiles the user has explicitly told to use their saved Mockups render even
   * though the fingerprint no longer matches the current inputs. Keyed by
   * `<listingId>:<mockupId>`.
   */
  const [forceOverrides, setForceOverrides] = React.useState<Record<string, true>>({});
  const [rowOverrides, setRowOverrides] = React.useState<Record<string, true>>({});

  // The render loop is long. If the user edits copy/selection on another page
  // while it runs, the final save must use that newer state, not the snapshot
  // captured at click time.
  const sessionRef = React.useRef(session);
  /**
   * The signatures of the products prepared by the current Send. They are
   * written to the session only after the extension reports a fully successful
   * apply, so a failed or partial apply never makes the preview skip images.
   */
  const appliedSignaturesRef = React.useRef<
    Record<string, StudioListingMockupsApplied>
  >({});
  React.useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const listings = React.useMemo(
    () => buildStudioListings((designs ?? []) as Design[], session),
    [designs, session],
  );
  const rows = React.useMemo(() => groupStudioListings(listings), [listings]);
  /**
   * Library designs that contribute to no listing in the batch. They are NOT
   * auto-added: an empty tick list means "no products", and turning a stray
   * design into a Printify product must stay the user's click.
   */
  const notInBatch = React.useMemo(() => {
    const covered = new Set<string>();
    for (const listing of listings) {
      for (const id of listing.memberIds) covered.add(id);
    }
    return (designs ?? []).filter((design) => !covered.has(design.id));
  }, [designs, listings]);
  const designsById = React.useMemo(
    () => new Map((designs ?? []).map((design) => [design.id, design])),
    [designs],
  );
  const mockupsById = React.useMemo(
    () => new Map((mockups ?? []).map((mockup) => [mockup.id, mockup])),
    [mockups],
  );
  const placementsByKey = React.useMemo(
    () =>
      new Map(
        (placements ?? []).map((placement) => [
          `${placement.designId}:${placement.mockupId}`,
          placement as Placement,
        ]),
      ),
    [placements],
  );
  const resultsByListing = React.useMemo(() => {
    const map = new Map<string, StudioProductResult>();
    for (const result of results ?? []) {
      if (result.status === "created" && result.remoteProductId) {
        map.set(result.designId, result);
      }
    }
    return map;
  }, [results]);

  /**
   * Every PRODUCT mockup in library order - the default selection for a new
   * listing.
   *
   * Info cards are not product photos: they never become a Printify mockup,
   * so they are not part of a listing's image selection.
   */
  const allMockupIds = React.useMemo(
    () => productMockups(mockups ?? []).map((mockup) => mockup.id),
    [mockups],
  );
  /**
   * The product mockups in the SHARED order.
   *
   * The order is shared by every listing whose "Own order" toggle is OFF, so
   * a drag in any such row moves the photographs on all of them. A detached
   * design overrides this list through `orderedIdsForListing` below.
   */
  const orderedMockupIds = React.useMemo(
    () => applyGlobalOrder(session, allMockupIds),
    [session, allMockupIds],
  );
  const adoptionIndex = React.useMemo(
    () => buildAdoptionIndex((renderAssets ?? []) as AssetMeta[]),
    [renderAssets],
  );
  /**
   * Every saved render, fingerprint or not, newest first. This is what the
   * manual "link saved renders" path reads: renders saved before fingerprints
   * existed can never be adopted automatically, but they are still the user's
   * own pixels.
   */
  const savedRenderIndex = React.useMemo(
    () => buildSavedRenderIndex((renderAssets ?? []) as AssetMeta[]),
    [renderAssets],
  );

  /**
   * What this listing will actually send.
   *
   * An explicit list (or an explicit Clear) wins. A listing that has NEVER
   * been configured starts with everything: the page exists to review and
   * remove, not to tick fifty mockups by hand — and the default selection is
   * in the GLOBAL order, so the drag decides which photograph is the main
   * image on every listing, configured or not. The distinction matters to the
   * drafts engine, which treats "never configured" and "deliberately empty"
   * differently, so this helper never invents an empty list.
   */
  const effectiveIdsFor = React.useCallback(
    (listing: StudioListing): string[] => {
      const configured = session.listingImages?.[listing.listingId] !== undefined;
      if (configured) {
        return listingMockupIds(session, listing.listingId).filter((id) => {
          const mockup = mockupsById.get(id);
          return !!mockup && isProductMockup(mockup);
        });
      }
      if (session.listingImageCleared?.[listing.listingId] === true) return [];
      // A never-configured row starts with every mockup, in the order THIS
      // listing shows - the shared order unless the row is detached, so a new
      // listing on a detached design agrees with its own strip.
      return orderedIdsForListing(session, listing.listingId, orderedMockupIds);
    },
    [session, mockupsById, orderedMockupIds],
  );

  /**
   * The info cards attached to this listing.
   *
   * Cards attach by the category of the product mockups included in the
   * listing - no Printify key needed. Product photos upload first, then the
   * cards in this order, which is also their global order (shared with the
   * mockups strip, so a drag here persists like any other listing image).
   */
  const infoCardsFor = React.useCallback(
    (listing: StudioListing): Mockup[] => {
      if (!mockups) return [];
      const attached = infoCardsForListing(mockups, effectiveIdsFor(listing));
      const ids = attached.map((card) => card.id);
      // Same rule as the mockup tiles: a detached design sorts its cards by
      // its own order, everyone else by the shared one.
      return orderedIdsForListing(session, listing.listingId, ids)
        .map((id) => mockupsById.get(id))
        .filter((card): card is Mockup => !!card);
    },
    [mockups, effectiveIdsFor, session, mockupsById],
  );

  /** The current render for a selection row: the session entry, else an adopted asset. */
  const currentEntry = React.useCallback(
    (image: SelectedImage): StudioListingRender | undefined => {
      if (image.overridden) return image.entry ?? image.adopted;
      return image.fresh && image.entry ? image.entry : image.adopted;
    },
    [],
  );

  const selectionFor = React.useCallback(
    (listing: StudioListing): SelectedImage[] => {
      return effectiveIdsFor(listing)
        .map((mockupId) => mockupsById.get(mockupId))
        .filter((mockup): mockup is Mockup => !!mockup)
        .map((mockup) => {
          const entry = listingRenderFor(session, listing.listingId, mockup.id);
          const saved = placementsByKey.get(`${listing.designId}:${mockup.id}`);
          const fingerprint = listingImageFingerprint({
            listing,
            mockup,
            placement: placementFor(session, listing.designId),
            saved,
          });
          const fresh = isListingRenderFresh(entry, fingerprint);
          const adoptedAsset = fresh
            ? null
            : matchInAdoptionIndex(
                adoptionIndex,
                listing.artworkAssetId,
                mockup.id,
                fingerprint,
              );
          const key = listingRenderKey(listing.listingId, mockup.id);
          const overridden = Boolean(forceOverrides[key] || rowOverrides[key]);
          return {
            mockup,
            entry,
            fresh,
            overridden,
            adopted: adoptedAsset
              ? adoptedRenderEntry({
                  asset: adoptedAsset,
                  fingerprint,
                  designId: listing.designId,
                  mockupId: mockup.id,
                })
              : undefined,
            fingerprint,
          };
        });
    },
    [session, mockupsById, placementsByKey, effectiveIdsFor, adoptionIndex, forceOverrides, rowOverrides],
  );

  /**
   * Records an adopted render in the session.
   *
   * Drawing the saved pixels on the tile is only half the job: Send, the
   * listing drafts and the Export Center read `session.listingRenders`, and
   * without this entry they would still describe the render this page already
   * replaced (or none at all). It is deliberately keyed on the asset id, so a
   * second pass finds nothing to write and the effect settles instead of
   * saving the session on every render.
   */
  React.useEffect(() => {
    if (rendering || sending) return;
    const adopted: Record<string, StudioListingRender> = {};
    for (const listing of listings) {
      for (const image of selectionFor(listing)) {
        if (!image.adopted) continue;
        const key = listingRenderKey(listing.listingId, image.mockup.id);
        if (session.listingRenders?.[key]?.assetId === image.adopted.assetId) continue;
        adopted[key] = image.adopted;
      }
    }
    if (Object.keys(adopted).length === 0) return;
    update({ listingRenders: { ...(session.listingRenders ?? {}), ...adopted } });
  }, [rendering, sending, listings, selectionFor, session.listingRenders, update]);

  /**
   * Tiles with no current render whose pair nonetheless has a saved render.
   *
   * `linkSavedRenderEntries` decides both the count and what a click writes, so
   * the banner can never offer a number the button would not deliver. Covered
   * tiles - a fresh session entry or a fingerprint-matched adoption - are
   * skipped: linking them would only replace fresher pixels.
   */
  const linkableTargets = React.useMemo<LinkableRenderTarget[]>(() => {
    const targets: LinkableRenderTarget[] = [];
    for (const listing of listings) {
      for (const image of selectionFor(listing)) {
        targets.push({
          key: listingRenderKey(listing.listingId, image.mockup.id),
          artworkAssetId: listing.artworkAssetId,
          designId: listing.designId,
          mockupId: image.mockup.id,
          fingerprint: image.fingerprint,
          covered: Boolean(currentEntry(image)),
        });
      }
    }
    return targets;
  }, [listings, selectionFor, currentEntry]);
  const linkableEntries = React.useMemo(
    () => linkSavedRenderEntries(savedRenderIndex, linkableTargets),
    [savedRenderIndex, linkableTargets],
  );
  const linkableCount = Object.keys(linkableEntries).length;

  /**
   * The explicit "link my saved renders" recovery.
   *
   * It writes each pairing under the CURRENT fingerprint, which is what makes
   * the tile, the drafts engine and Send stop calling those pixels unrendered.
   * It is deliberately a click: the app cannot prove an old render still
   * matches the design or the print area, so the user is the one saying so.
   */
  const linkSavedRenders = React.useCallback(() => {
    const count = Object.keys(linkableEntries).length;
    if (count === 0) return;
    update({
      listingRenders: { ...(session.listingRenders ?? {}), ...linkableEntries },
    });
    toast.success(
      `Linked ${count} saved render${count === 1 ? "" : "s"} from Mockups.`,
    );
  }, [linkableEntries, session.listingRenders, update]);

  /** Force one tile to use its saved Mockups render even if it is out of date. */
  const forceTileOverride = React.useCallback(
    (listing: StudioListing, mockupId: string) => {
      const key = listingRenderKey(listing.listingId, mockupId);
      setForceOverrides((prev) => ({ ...prev, [key]: true }));
    },
    [],
  );

  /** Release a forced tile override so it re-evaluates freshness normally. */
  const clearTileOverride = React.useCallback(
    (listing: StudioListing, mockupId: string) => {
      const key = listingRenderKey(listing.listingId, mockupId);
      setForceOverrides((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  /** Force every tile in one listing (row of tiles) to use its saved render. */
  const forceRowOverride = React.useCallback(
    (listing: StudioListing) => {
      const keys: string[] = [];
      for (const image of selectionFor(listing)) {
        keys.push(listingRenderKey(listing.listingId, image.mockup.id));
      }
      setRowOverrides((prev) => {
        const next = { ...prev };
        for (const key of keys) next[key] = true;
        return next;
      });
      toast.success(`Using saved Mockups renders for "${listing.designName}".`);
    },
    [selectionFor],
  );

  /** Release every forced override in one listing. */
  const clearRowOverride = React.useCallback(
    (listing: StudioListing) => {
      const keys: string[] = [];
      for (const image of selectionFor(listing)) {
        keys.push(listingRenderKey(listing.listingId, image.mockup.id));
      }
      setRowOverrides((prev) => {
        const next = { ...prev };
        for (const key of keys) delete next[key];
        return next;
      });
    },
    [selectionFor],
  );

  const totalSelected = React.useMemo(
    () => listings.reduce((sum, listing) => sum + selectionFor(listing).length, 0),
    [listings, selectionFor],
  );
  const freshSelected = React.useMemo(
    () =>
      listings.reduce(
        (sum, listing) =>
          sum + selectionFor(listing).filter((image) => Boolean(currentEntry(image))).length,
        0,
      ),
    [listings, selectionFor, currentEntry],
  );
  const canSend = React.useMemo(
    () =>
      listings.some((listing) => {
        const result = resultsByListing.get(listing.listingId);
        return Boolean(
          result?.remoteProductId &&
            selectionFor(listing).some((image) => Boolean(currentEntry(image))),
        );
      }),
    [listings, resultsByListing, selectionFor, currentEntry],
  );

  const selectionPatch = React.useCallback(
    (
      listingId: string,
      ids: string[],
      cleared: boolean,
    ): Pick<StudioSession, "listingImages" | "listingImageCleared"> => {
      const listingImages = { ...(session.listingImages ?? {}) };
      const listingImageCleared = { ...(session.listingImageCleared ?? {}) };
      if (ids.length > 0) {
        listingImages[listingId] = ids;
        delete listingImageCleared[listingId];
      } else {
        delete listingImages[listingId];
        if (cleared) listingImageCleared[listingId] = true;
        else delete listingImageCleared[listingId];
      }
      return { listingImages, listingImageCleared };
    },
    [session.listingImages, session.listingImageCleared],
  );

  const toggleMockup = React.useCallback(
    (listing: StudioListing, mockupId: string) => {
      if (rendering || sending) return;
      // Toggle against the EFFECTIVE list, so the first click on a listing that
      // still shows every mockup removes exactly one and keeps the rest.
      const current = effectiveIdsFor(listing);
      const next = current.includes(mockupId)
        ? current.filter((id) => id !== mockupId)
        : [...current, mockupId];
      update(selectionPatch(listing.listingId, next, next.length === 0));
    },
    [effectiveIdsFor, update, selectionPatch, rendering, sending],
  );

  const selectAll = React.useCallback(
    (listing: StudioListing) => {
      if (rendering || sending) return;
      const current = effectiveIdsFor(listing);
      const next = [...current, ...allMockupIds.filter((id) => !current.includes(id))];
      update(selectionPatch(listing.listingId, next, false));
    },
    [effectiveIdsFor, allMockupIds, update, selectionPatch, rendering, sending],
  );

  const clearListing = React.useCallback(
    (listing: StudioListing) => {
      if (rendering || sending) return;
      update(selectionPatch(listing.listingId, [], true));
    },
    [update, selectionPatch, rendering, sending],
  );

  // --- removal set -----------------------------------------------------------
  // A long-press starts a removal set for ONE row. While it is open, a click
  // toggles membership instead of flipping the listing's selection, and the
  // row's action bar commits or cancels the whole set. Nothing is persisted
  // until the user commits, so a mis-press is always recoverable.
  const [removal, setRemoval] = React.useState<{
    listingId: string;
    marked: Set<string>;
  } | null>(null);

  const LONG_PRESS_MS = 500;
  const longPressTimer = React.useRef<number | null>(null);
  const longPressStart = React.useRef<{ x: number; y: number } | null>(null);
  const suppressClick = React.useRef(false);

  const cancelPress = React.useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  }, []);

  /**
   * Ends a gesture.
   *
   * The suppression flag is cleared on the NEXT task, never here: the browser
   * dispatches the click immediately after `pointerup`, and that click is the
   * one the long-press owns. Deferring it also means a gesture that produces no
   * click at all - a right-click, a drag off the tile, a pointercancel - cannot
   * leave the flag behind to swallow the next, unrelated click.
   */
  const releasePress = React.useCallback(() => {
    cancelPress();
    if (!suppressClick.current) return;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }, [cancelPress]);

  const startPress = React.useCallback(
    (listing: StudioListing, mockupId: string) => (event: React.PointerEvent) => {
      if (rendering || sending || event.button !== 0) return;
      cancelPress();
      // A new press is never the continuation of an old one, so a flag left
      // over from a gesture whose click never arrived cannot eat this click.
      suppressClick.current = false;
      longPressStart.current = { x: event.clientX, y: event.clientY };
      longPressTimer.current = window.setTimeout(() => {
        longPressTimer.current = null;
        longPressStart.current = null;
        // The browser will still deliver a click when the finger lifts; this
        // flag makes that click belong to the long-press, not a toggle.
        suppressClick.current = true;
        // Only an included tile has anything to remove. Long-pressing one that
        // is already excluded opens nothing - and the suppressed click means it
        // is not quietly re-included on release either.
        if (!effectiveIdsFor(listing).includes(mockupId)) return;
        setRemoval((prev) => {
          const marked =
            prev?.listingId === listing.listingId ? new Set(prev.marked) : new Set<string>();
          marked.add(mockupId);
          return { listingId: listing.listingId, marked };
        });
      }, LONG_PRESS_MS);
    },
    [rendering, sending, cancelPress, effectiveIdsFor],
  );

  const movePress = React.useCallback(
    (event: React.PointerEvent) => {
      const start = longPressStart.current;
      if (!start) return;
      if (
        Math.abs(event.clientX - start.x) > 8 ||
        Math.abs(event.clientY - start.y) > 8
      ) {
        cancelPress();
      }
    },
    [cancelPress],
  );

  const beginRemoval = React.useCallback(
    (listing: StudioListing, mockupId: string) => {
      if (rendering || sending) return;
      // The same rule as the long-press: only an included tile can be removed,
      // so a right-click on an excluded one must not open a set that can never
      // do anything.
      if (!effectiveIdsFor(listing).includes(mockupId)) return;
      suppressClick.current = true;
      setRemoval((prev) => {
        const marked =
          prev?.listingId === listing.listingId ? new Set(prev.marked) : new Set<string>();
        marked.add(mockupId);
        return { listingId: listing.listingId, marked };
      });
    },
    [rendering, sending, effectiveIdsFor],
  );

  const toggleRemovalMark = React.useCallback(
    (listing: StudioListing, mockupId: string) => {
      if (removal?.listingId !== listing.listingId) return;
      // Clicking an excluded tile while the set is open is not a mark: there is
      // nothing there to take out of the selection.
      if (!effectiveIdsFor(listing).includes(mockupId)) return;
      setRemoval((prev) => {
        if (!prev || prev.listingId !== listing.listingId) return prev;
        const marked = new Set(prev.marked);
        if (marked.has(mockupId)) marked.delete(mockupId);
        else marked.add(mockupId);
        return { listingId: prev.listingId, marked };
      });
    },
    [removal, effectiveIdsFor],
  );

  const onTileClick = React.useCallback(
    (listing: StudioListing, mockupId: string) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (removal?.listingId === listing.listingId) {
        toggleRemovalMark(listing, mockupId);
        return;
      }
      toggleMockup(listing, mockupId);
    },
    [removal, toggleRemovalMark, toggleMockup],
  );

  const applyRemoval = React.useCallback(
    (listing: StudioListing) => {
      if (!removal || removal.listingId !== listing.listingId) return;
      const current = effectiveIdsFor(listing);
      const next = current.filter((id) => !removal.marked.has(id));
      // Count what actually leaves the selection, not what is marked: a mark on
      // an excluded tile (or a selection that shrank while the set was open)
      // must not be reported as removed.
      const removed = current.length - next.length;
      setRemoval(null);
      if (removed === 0) return;
      update(selectionPatch(listing.listingId, next, next.length === 0));
      toast.success(
        `Removed ${removed} mockup${removed === 1 ? "" : "s"} from ${
          listing.designName
        } - they will not be sent to Printify.`,
      );
    },
    [removal, effectiveIdsFor, update, selectionPatch],
  );

  /**
   * The "Own order" toggle for ONE design's row.
   *
   * ON (the key being present in `listingImageOrders`): the row is detached
   * from the shared order. The entry is seeded with the order the row shows
   * right now, so switching cannot visibly jump the tiles.
   * OFF: the entry is deleted and the row returns to the shared order. The
   * design's own order IS discarded - that is what "back to shared" means -
   * so it is confirmed when the two orders actually differ.
   */
  const toggleOwnOrder = React.useCallback(
    (listing: StudioListing) => {
      const listingId = listing.listingId;
      const own = session.listingImageOrders?.[listingId];
      if (own === undefined) {
        update({
          listingImageOrders: {
            ...(session.listingImageOrders ?? {}),
            // The row was on the shared order, so this IS its current order:
            // the tile strip does not move when the toggle goes on.
            [listingId]: orderedIdsForListing(session, listingId, allMockupIds),
          },
        });
        return;
      }
      const discard = () => {
        const next = { ...(session.listingImageOrders ?? {}) };
        delete next[listingId];
        update({ listingImageOrders: next });
      };
      const shared = applyGlobalOrder(session, allMockupIds);
      const current = orderedIdsForListing(session, listingId, allMockupIds);
      if (current.length === shared.length && current.every((id, i) => id === shared[i])) {
        discard();
        return;
      }
      setOwnOrderConfirm({ listingName: listing.designName, apply: discard });
    },
    [session, allMockupIds, update],
  );

  /** Writes a dragged list into ONE detached row's own order - never the shared list. */
  const updateOwnOrder = React.useCallback(
    (listingId: string, dragged: string[]) => {
      update({
        listingImageOrders: {
          ...(session.listingImageOrders ?? {}),
          [listingId]: mergeOwnOrder(session.listingImageOrders?.[listingId], dragged),
        },
      });
    },
    [session.listingImageOrders, update],
  );

  /**
   * The explicit selection a session would store.
   *
   * A listing that still uses the default (every mockup) has no explicit list,
   * and the drafts engine reads the list - not this page's default. Writing the
   * effective ids out makes what the page shows and what Printify gets the same
   * thing. Called with the LATEST session before saving, so an edit made while
   * a render ran is never put back to the snapshot this page last saw.
   */
  const explicitSelection = React.useCallback(
    (base: StudioSession, scope: StudioListing[]): Record<string, string[]> => {
      const listingImages = { ...(base.listingImages ?? {}) };
      for (const listing of scope) {
        if (
          listingImages[listing.listingId] === undefined &&
          base.listingImageCleared?.[listing.listingId] !== true
        ) {
          // The default becomes explicit in the order the row shows - own
          // order for a detached design, the shared one otherwise - so what
          // Printify receives later matches the strip the user has seen.
          listingImages[listing.listingId] = orderedIdsForListing(
            base,
            listing.listingId,
            orderedMockupIds,
          );
        }
      }
      return listingImages;
    },
    [orderedMockupIds],
  );

  /**
   * Persists the effective selection before a long operation.
   *
   * It is a user gesture (a render or a send), so the drafts engine may lock
   * the list that is written here.
   */
  const persistEffectiveSelection = React.useCallback((): Record<string, string[]> => {
    const listingImages = explicitSelection(session, listings);
    update({ listingImages });
    return listingImages;
  }, [explicitSelection, session, listings, update]);

  const renderSelected = async () => {
    if (rendering || sending) return;
    const targets = listings.flatMap((listing) =>
      selectionFor(listing).map((image) => ({ listing, image })),
    );
    if (targets.length === 0) {
      toast.error("No mockups are included in this batch yet.");
      return;
    }

    // Make the default selection explicit before the long part starts, so the
    // drafts written at the end describe exactly the tiles on screen.
    persistEffectiveSelection();

    setRendering(true);
    setProgress({ done: 0, total: targets.length, label: "Preparing…" });
    const nextRenders: Record<string, StudioListingRender> = {
      ...(session.listingRenders ?? {}),
    };
    const failures: string[] = [];
    let reused = 0;
    let rendered = 0;

    try {
      for (const [index, target] of targets.entries()) {
        const { listing, image } = target;
        setProgress({
          done: index,
          total: targets.length,
          label: `${listing.designName} · ${image.mockup.name}`,
        });
        const key = listingRenderKey(listing.listingId, image.mockup.id);
        // A current render - from this session OR adopted from the Mockups
        // panel by fingerprint - is reused. Adoption is what makes "the
        // mockups we saved in the Mockups panel" arrive here with no work.
        const current = currentEntry(image);
        if (current?.assetId && (await db.assets.get(current.assetId))) {
          nextRenders[key] = current;
          reused++;
          setProgress({
            done: index + 1,
            total: targets.length,
            label: `${listing.designName} · reused ${image.mockup.name}`,
          });
          continue;
        }

        const design = designsById.get(listing.designId);
        if (!design) {
          delete nextRenders[key];
          failures.push(`${listing.designName}: design is no longer in the library`);
          setProgress({
            done: index + 1,
            total: targets.length,
            label: `${listing.designName} · design missing`,
          });
          continue;
        }
        try {
          const result = await renderListingMockup({
            listing,
            design,
            mockup: image.mockup,
            // The placement is part of the fingerprint, so it is read fresh: a
            // move made on another page mid-render must be what the pixels and
            // the recorded fingerprint both describe, or the drafts engine will
            // (rightly) reject the render as obsolete.
            placement: placementFor(sessionRef.current, listing.designId),
          });
          nextRenders[key] = {
            assetId: result.assetId,
            fingerprint: result.fingerprint,
            designId: listing.designId,
            mockupId: image.mockup.id,
            renderedAt: Date.now(),
          };
          rendered++;
        } catch (error) {
          delete nextRenders[key];
          failures.push(
            `${listing.designName} · ${image.mockup.name}: ${
              error instanceof Error ? error.message : "render failed"
            }`,
          );
        }
        setProgress({
          done: index + 1,
          total: targets.length,
          label: `${listing.designName} · ${image.mockup.name}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Rebuild the scope from the live session and designs: the user may have
      // changed the batch or the copy while the render loop was running.
      const latestDesigns = (await db.designs.toArray()) as Design[];
      const latest = sessionRef.current;
      const latestListings = buildStudioListings(latestDesigns, latest);

      const targetKeys = new Set(
        targets.map((target) => listingRenderKey(target.listing.listingId, target.image.mockup.id)),
      );
      const mergedRenders: Record<string, StudioListingRender> = {
        ...(latest.listingRenders ?? {}),
      };
      for (const key of targetKeys) {
        if (nextRenders[key]) mergedRenders[key] = nextRenders[key];
        else delete mergedRenders[key];
      }

      // Re-derive the selection from the LATEST session rather than writing the
      // snapshot taken at click time. A tick made on another page during the
      // loop must not be put back to what this page last saw; the default
      // selection is re-applied to every listing that still has none, so the
      // drafts still describe every tile on screen.
      const latestImages = explicitSelection(latest, latestListings);
      const nextSession: StudioSession = {
        ...latest,
        listingImages: latestImages,
        listingRenders: mergedRenders,
      };
      update({ listingImages: latestImages, listingRenders: mergedRenders });

      const saved = await saveStudioListingDrafts({
        session: nextSession,
        listings: latestListings,
        productName: catalogProductName(catalog.blueprints, latest.blueprintId),
      });

      const parts = [
        rendered > 0 ? `${rendered} rendered` : "",
        reused > 0 ? `${reused} reused` : "",
        `${saved.saved} listing draft${saved.saved === 1 ? "" : "s"} saved`,
      ].filter(Boolean);
      if (failures.length > 0) {
        toast.warning(`${parts.join(" · ")}. ${failures.length} failed.`);
      } else {
        toast.success(parts.join(" · "));
      }
      if (failures.length > 0) {
        console.warn("Listing image renders failed", failures);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the listing images");
    } finally {
      setRendering(false);
      setProgress({ done: 0, total: 0, label: "" });
    }
  };

  const downloadListings = async (targets: StudioListing[], label: string) => {
    const files: Zippable = {};
    let included = 0;
    let skipped = 0;
    let unrendered = 0;
    for (const listing of targets) {
      const selected = selectionFor(listing);
      const images = selected.filter((image) => Boolean(currentEntry(image)));
      unrendered += selected.length - images.length;
      if (images.length === 0) continue;
      const folder = `MockupStudio_Listing_Images/${safeName(
        listing.designName,
      )}-${listing.listingId.slice(0, 6)}`;
      for (const [index, image] of images.entries()) {
        const entry = currentEntry(image);
        const blob = entry ? await getAssetBlob(entry.assetId) : null;
        if (!blob) {
          skipped++;
          continue;
        }
        const ext = extensionFor(blob);
        const path = `${folder}/${String(index + 1).padStart(2, "0")}-${safeName(
          image.mockup.name,
        )}.${ext}`;
        files[path] = [new Uint8Array(await blob.arrayBuffer()), { level: 6 }];
        included++;
      }
    }
    if (included === 0) {
      toast.error("None of the selected images has a current render. Use Save & render first.");
      return;
    }
    try {
      await zipFiles(files, `listing-images-${label}.zip`);
      toast.success(`Downloaded ${included} image${included === 1 ? "" : "s"}.`);
      if (skipped > 0) {
        toast.warning(`${skipped} selected image${skipped === 1 ? "" : "s"} had no stored file.`);
      }
      if (unrendered > 0) {
        toast.warning(
          `${unrendered} selected image${unrendered === 1 ? "" : "s"} ${
            unrendered === 1 ? "needs" : "need"
          } a current render and was not downloaded.`,
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the ZIP");
    }
  };

  const sendToPrintify = async (only?: StudioListing[]) => {
    if (rendering || sending) return;
    const targets = only ?? listings;
    if (targets.length === 0) {
      toast.error("There are no listings to send.");
      return;
    }

    setSending(true);
    appliedSignaturesRef.current = {};
    setSendProgress({ done: 0, total: targets.length, label: "Preparing images…" });
    // Same reason as Save & render: a listing still on the default selection
    // must send the tiles the page showed, not an empty list.
    persistEffectiveSelection();
    const prepared: PrintifyBridgeProduct[] = [];
    const failures: string[] = [];
    const skipped: string[] = [];

    try {
      for (const [index, listing] of targets.entries()) {
        const result = resultsByListing.get(listing.listingId);
        const selected = selectionFor(listing);
        const images = selected.filter((image) => Boolean(currentEntry(image)));
        // Info cards upload after the product mockups, in strip order. They are
        // static pixels, so they need no render and no fingerprint.
        const cards = infoCardsFor(listing);

        if (!result?.remoteProductId) {
          skipped.push(`${listing.designName}: create the Printify product first`);
          continue;
        }
        if (images.length === 0) {
          skipped.push(`${listing.designName}: no current renders selected`);
          continue;
        }
        if (images.length < selected.length) {
          // All-or-nothing: a partial set changes the order, which changes the
          // product's main image. Render the missing images instead of guessing.
          skipped.push(
            `${listing.designName}: render all ${
              selected.length
            } selected images first (${selected.length - images.length} still need a current render)`,
          );
          continue;
        }

        try {
          const uploads: PrintifyMockupUpload[] = [];
          let shopId = result.shopId;
          let productTitle = result.title;
          // Cards need no render, so their pixels are read up front, in strip
          // order, and uploaded after the product mockups.
          const cardPayloads: Array<{ base64: string; filename: string }> = [];
          for (const card of cards) {
            const blob = await getAssetBlob(card.assetId);
            if (!blob) {
              throw new Error(`Info card "${card.name}" has no stored image`);
            }
            cardPayloads.push(
              await mockupImageForUpload(blob, `${listing.designName}-info-${card.name}`),
            );
          }
          for (let start = 0; start < images.length; start += MAX_IMAGES_PER_UPLOAD) {
            const chunk = images.slice(start, start + MAX_IMAGES_PER_UPLOAD);
            setSendProgress({
              done: index,
              total: targets.length,
              label: `${listing.designName}: uploading ${Math.min(
                start + chunk.length,
                images.length,
              )}/${images.length}…`,
            });
            const payloadImages: Array<{ base64: string; filename: string }> = [];
            for (const image of chunk) {
              const entry = currentEntry(image);
              const blob = entry ? await getAssetBlob(entry.assetId) : null;
              if (!blob) {
                throw new Error(`${image.mockup.name} has no stored render`);
              }
              const converted = await mockupImageForUpload(
                blob,
                `${listing.designName}-${image.mockup.name}`,
              );
              payloadImages.push(converted);
            }
            // No `expectedTitle`: this page never edits the product title
            // (Listing preview does), so the stored creation title goes stale
            // after any title change elsewhere and the upload would 409.
            // The product id is the identity; the server resolves it with
            // the caller's own key.
            const response = await authedFetch("/api/printify/mockups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                confirm: true,
                shopId,
                productId: result.remoteProductId,
                images: payloadImages,
              }),
            });
            const data = (await response.json().catch(() => null)) as UploadResponse | null;
            if (!response.ok) {
              throw new Error(data?.error ?? `HTTP ${response.status}`);
            }
            if (!data || !Array.isArray(data.uploads) || data.uploads.length !== chunk.length) {
              throw new Error("Printify did not return one custom mockup per image");
            }
            uploads.push(...data.uploads);
            shopId = data.shopId ?? shopId;
            productTitle = data.title ?? productTitle;
          }
          for (let start = 0; start < cardPayloads.length; start += MAX_IMAGES_PER_UPLOAD) {
            const chunk = cardPayloads.slice(start, start + MAX_IMAGES_PER_UPLOAD);
            setSendProgress({
              done: index,
              total: targets.length,
              label: `${listing.designName}: uploading info cards ${Math.min(
                start + chunk.length,
                cardPayloads.length,
              )}/${cardPayloads.length}…`,
            });
            const response = await authedFetch("/api/printify/mockups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                confirm: true,
                shopId,
                productId: result.remoteProductId,
                images: chunk,
              }),
            });
            const data = (await response.json().catch(() => null)) as UploadResponse | null;
            if (!response.ok) {
              throw new Error(data?.error ?? `HTTP ${response.status}`);
            }
            if (!data || !Array.isArray(data.uploads) || data.uploads.length !== chunk.length) {
              throw new Error("Printify did not return one custom mockup per info card");
            }
            uploads.push(...data.uploads);
            shopId = data.shopId ?? shopId;
            productTitle = data.title ?? productTitle;
          }
          if (shopId == null || !Number.isFinite(shopId) || shopId <= 0) {
            throw new Error("Printify did not return the shop for this product");
          }
          const signatureImages = [
            ...images.flatMap((image) => {
              const entry = currentEntry(image);
              return entry
                ? [{ mockupId: image.mockup.id, fingerprint: entry.fingerprint }]
                : [];
            }),
            ...cards.map((card) => ({
              mockupId: card.id,
              fingerprint: `info-card:${card.assetId}`,
            })),
          ];
          if (signatureImages.length === images.length + cards.length) {
            appliedSignaturesRef.current[listing.listingId] = appliedMockupRecord(
              result.remoteProductId,
              signatureImages,
            );
          }
          prepared.push({
            shopId,
            productId: result.remoteProductId,
            productTitle,
            uploads,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "upload failed";
          failures.push(`${listing.designName}: ${message}`);
          console.warn("Listing image upload failed", listing.designName, error);
        }
        setSendProgress({
          done: index + 1,
          total: targets.length,
          label: "products prepared…",
        });
      }

      if (prepared.length === 0) {
        // Keep the dialog open with the full failures/skipped list - a
        // truncated toast hides why every listing was rejected.
        setBridgePayload("");
        setBridgePayloadData(null);
        setBridgeApplied(null);
        setBridgeCopied(false);
        setBridgeSummary({ products: 0, images: 0, failures, skipped });
        setBridgeOpen(true);
        toast.error("Nothing was prepared for Printify. See the dialog for why.");
        return;
      }

      const payload = buildBridgePayload(prepared);
      const json = bridgePayloadJson(payload);
      setBridgePayload(json);
      setBridgePayloadData(payload);
      setBridgeApplied(null);
      setBridgeCopied(false);
      setBridgeSummary({
        products: prepared.length,
        images: countBridgeImages(payload),
        failures,
        skipped,
        firstProductId: prepared.length === 1 ? prepared[0].productId : undefined,
      });
      setBridgeOpen(true);
      try {
        await navigator.clipboard.writeText(json);
        setBridgeCopied(true);
        toast.success(
          `Prepared ${countBridgeImages(payload)} image${
            countBridgeImages(payload) === 1 ? "" : "s"
          }. The payload is on your clipboard.`,
        );
      } catch {
        toast.success("Payload prepared. Copy it from the dialog.");
      }
      try {
        await logActivity(
          "product.create",
          `Prepared ${countBridgeImages(payload)} listing image${
            countBridgeImages(payload) === 1 ? "" : "s"
          } for Printify`,
        );
      } catch {
        // The payload is ready; activity logging must not turn it into a failure.
      }
      if (failures.length > 0 || skipped.length > 0) {
        toast.warning(
          `${failures.length + skipped.length} listing${
            failures.length + skipped.length === 1 ? "" : "s"
          } skipped. See the dialog.`,
        );
      }
      // One-click: when the bridge extension is loaded, hand the payload
      // straight to it - otherwise Send only prepares and leaves a second
      // manual click. The dialog shows the extension's answer.
      if (companionExtensionReady()) {
        setExtensionReady(true);
        setExtensionOld(false);
        const requestId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `req-${Date.now()}`;
        applyRequestId.current = requestId;
        setExtensionApplying(true);
        setBridgeApplied(null);
        window.dispatchEvent(
          new CustomEvent("mockup-studio:apply-request", {
            detail: { payload, requestId },
          }),
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not prepare the payload");
    } finally {
      setSending(false);
      setSendProgress({ done: 0, total: 0, label: "" });
    }
  };

  const copyPayload = async () => {
    try {
      await navigator.clipboard.writeText(bridgePayload);
      setBridgeCopied(true);
      toast.success("Payload copied.");
    } catch {
      toast.error("Could not copy. Select the text in the box instead.");
    }
  };

  const openPrintify = () => {
    const url = bridgeSummary?.firstProductId
      ? `https://printify.com/app/products/${bridgeSummary.firstProductId}`
      : "https://printify.com/app/products";
    window.open(url, "_blank", "noopener,noreferrer");
  };

  /**
   * Detect the companion extension.
   *
   * Its content script marks the document and announces itself once, so both
   * the first render and a later load (the user installed it and reloaded) are
   * covered. Without it the dialog keeps the clipboard + bookmarklet steps.
   *
   * A build older than protocol 2 is deliberately not used: it merges the
   * mockups instead of replacing them. The dialog says "reload" and keeps the
   * (new) bookmarklet path.
   */
  React.useEffect(() => {
    const sync = () => {
      setExtensionReady(companionExtensionReady());
      setExtensionOld(extensionOutdated());
    };
    sync();
    window.addEventListener("mockup-studio:extension-ready", sync as EventListener);
    return () =>
      window.removeEventListener("mockup-studio:extension-ready", sync as EventListener);
  }, []);

  /** Listen for the extension's answer to a one-click apply. */
  React.useEffect(() => {
    type ApplyResultDetail = {
      requestId?: string;
      ok?: boolean;
      results?: Array<{ id: string; ok: boolean; error?: string }>;
    };
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent).detail as ApplyResultDetail | undefined;
      if (!detail || detail.requestId !== applyRequestId.current) return;
      setExtensionApplying(false);
      const results = detail.results ?? [];
      const done = results.filter((result) => result.ok).length;
      const failures = results
        .filter((result) => !result.ok)
        .map((result) => `${result.id}: ${result.error ?? "not applied"}`);
      setBridgeApplied({ done, total: results.length, failures });
      if (detail.ok && failures.length === 0) {
        /*
         * Record exactly what was applied. Listing preview uses this to skip
         * re-uploading the same images when only the copy or price changes.
         * A partial apply records nothing, so the next Send stays safe.
         */
        const records = appliedSignaturesRef.current;
        if (Object.keys(records).length > 0) {
          update({
            listingMockupsApplied: {
              ...(sessionRef.current.listingMockupsApplied ?? {}),
              ...records,
            },
          });
        }
        toast.success(
          `Applied ${done} product${results.length === 1 ? "" : "s"} in Printify.`,
        );
      } else if (failures.length > 0) {
        toast.warning(
          `Applied ${done} of ${results.length}. ${failures.length} failed - see the dialog.`,
        );
      } else {
        toast.error("The extension could not apply the images.");
      }
    };
    const onError = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { requestId?: string; error?: string }
        | undefined;
      if (!detail || detail.requestId !== applyRequestId.current) return;
      setExtensionApplying(false);
      setBridgeApplied(null);
      toast.error(detail.error ?? "The extension could not apply the images.");
    };
    window.addEventListener("mockup-studio:apply-result", onResult as EventListener);
    window.addEventListener("mockup-studio:apply-error", onError as EventListener);
    return () => {
      window.removeEventListener("mockup-studio:apply-result", onResult as EventListener);
      window.removeEventListener("mockup-studio:apply-error", onError as EventListener);
    };
  }, []);

  /** The true one-click path: hand the payload to the extension and let it run. */
  const applyWithExtension = () => {
    if (!extensionReady || !bridgePayloadData) {
      toast.error("The Printify bridge extension is not installed yet. Use the bookmarklet below.");
      return;
    }
    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `req-${Date.now()}`;
    applyRequestId.current = requestId;
    setExtensionApplying(true);
    setBridgeApplied(null);
    window.dispatchEvent(
      new CustomEvent("mockup-studio:apply-request", {
        detail: { payload: bridgePayloadData, requestId },
      }),
    );
  };

  /** The design's 1-based position, oldest first - the same number as the Mockups tabs. */
  const listingNumber = (listing: StudioListing): number =>
    listings.findIndex((entry) => entry.listingId === listing.listingId) + 1;

  const renderListingRow = (listing: StudioListing) => {
    const selected = selectionFor(listing);
    const cards = infoCardsFor(listing);
    const current = selected.filter((image) => Boolean(currentEntry(image))).length;
    const result = resultsByListing.get(listing.listingId);
    const markedIds =
      removal !== null && removal.listingId === listing.listingId ? removal.marked : null;
    const removing = markedIds !== null;
    // Only an included tile can actually leave the listing, so only those
    // marks count - a stray mark must not enable a removal that does nothing.
    const markedCount = markedIds
      ? selected.filter((image) => markedIds.has(image.mockup.id)).length
      : 0;
    // The row's "Own order" toggle: a key in `listingImageOrders` means the
    // design is detached from the shared order, so drags only touch this row.
    const ownOrderOn = session.listingImageOrders?.[listing.listingId] !== undefined;
    // The full library in the order THIS row shows: its own entry when
    // detached, the shared order otherwise. The strip, the numbering and the
    // main-image badge all read this one list.
    const rowOrderIds = ownOrderOn
      ? orderedIdsForListing(session, listing.listingId, allMockupIds)
      : orderedMockupIds;
    // Tiles the "Use Mockups render" override can act on: a saved render that
    // exists but is no longer fresh, with no fingerprint-matched alternative.
    const overrideCandidates = selected.filter(
      (image) => image.entry && !image.fresh && !image.adopted,
    );
    const rowOverridden =
      overrideCandidates.length > 0 &&
      overrideCandidates.every((image) => image.overridden);

    return (
      <Card key={listing.listingId} data-listing-id={listing.listingId}>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-forest px-1.5 text-xs font-semibold text-white">
                {listingNumber(listing)}
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink">
                  {listing.designName}
                </h3>
                <p className="text-xs text-ink-muted">
                  {listing.partnerName
                    ? `One listing with ${listing.partnerName} · the first included tile is the main image`
                    : "The first included tile is the main image"}
                  {" · drag the handle to reorder (shared until Own order is on)"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={selected.length > 0 ? "forest" : "muted"}>
                {selected.length} included
              </Badge>
              {ownOrderOn && <Badge variant="outline">Own order</Badge>}
              {selected.length > 0 && (
                <Badge variant={current === selected.length ? "default" : "muted"}>
                  {current === selected.length ? "rendered" : `${current}/${selected.length} rendered`}
                </Badge>
              )}
              {result?.remoteProductId ? (
                <a
                  href={`https://printify.com/app/products/${result.remoteProductId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-xs text-forest hover:bg-surface-muted"
                >
                  <ExternalLink className="h-3 w-3" /> Product
                </a>
              ) : (
                <Button size="sm" variant="ghost" asChild>
                  <Link href="/printify-studio">Create product</Link>
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => selectAll(listing)}
              disabled={rendering || sending || orderedMockupIds.length === 0}
            >
              <Check className="h-3.5 w-3.5" /> Include all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => clearListing(listing)}
              disabled={rendering || sending || selected.length === 0}
            >
              Clear
            </Button>
            <Button
              size="sm"
              variant={ownOrderOn ? "secondary" : "outline"}
              onClick={() => toggleOwnOrder(listing)}
              disabled={rendering || sending || allMockupIds.length === 0}
              aria-pressed={ownOrderOn}
              title="Off: dragging changes the order for all designs. On: dragging changes the order for this design only."
            >
              Own order
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void downloadListings([listing], safeName(listing.designName))}
              disabled={rendering || sending || current === 0}
            >
              <Download className="h-3.5 w-3.5" /> Download
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void sendToPrintify([listing])}
              disabled={rendering || sending || current === 0 || !result?.remoteProductId}
            >
              <Send className="h-3.5 w-3.5" /> Send
            </Button>
            {overrideCandidates.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const run = () =>
                    rowOverridden ? clearRowOverride(listing) : forceRowOverride(listing);
                  if (!rowOverridden && lockedListings.has(listing.listingId)) {
                    setLockedConfirm({ listingName: listing.designName, apply: run });
                    return;
                  }
                  run();
                }}
                disabled={rendering || sending}
                className="text-amber"
              >
                {rowOverridden
                  ? "Clear row override"
                  : `Use Mockups renders (${overrideCandidates.length})`}
              </Button>
            )}
          </div>

          {removing && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
              <span className="mr-auto">
                Removal set: <strong>{markedCount}</strong> marked. Click more tiles to add or
                remove them from the set.
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => applyRemoval(listing)}
                disabled={markedCount === 0}
              >
                Remove {markedCount} from this listing
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoval(null)}>
                Cancel
              </Button>
            </div>
          )}

          {orderedMockupIds.length === 0 ? (
            <p className="rounded-md bg-surface-muted px-3 py-2 text-xs text-ink-muted">
              No mockups in the library yet. Add some on the{" "}
              <a className="text-forest underline" href="/mockups">
                Mockups page
              </a>
              , then come back.
            </p>
          ) : (
            <>
              <Reorder.Group
                as="div"
                axis="x"
                values={rowOrderIds}
                onReorder={(next) =>
                  ownOrderOn
                    ? updateOwnOrder(listing.listingId, next)
                    : update({ listingImageOrder: mergeGlobalOrder(session, next) })
                }
                className="flex gap-3 overflow-x-auto pb-1"
                role="list"
                aria-label={`Mockups for ${listing.designName}`}
              >
                {rowOrderIds.map((mockupId) => {
                  const mockup = mockupsById.get(mockupId);
                  if (!mockup) return null;
                  const image = selected.find((entry) => entry.mockup.id === mockup.id);
                  const order = image
                    ? selected.findIndex((entry) => entry.mockup.id === mockup.id) + 1
                    : 0;
                  const entry = image ? currentEntry(image) : undefined;
                  const marked = markedIds?.has(mockup.id) ?? false;
                  // The label is about THIS listing's design, not the shared
                  // default: a per-design frame is still a mapped area.
                  const area = printAreaOf(mockup, listing.designId);
                  return (
                    <DraggableTile
                      key={mockup.id}
                      value={mockup.id}
                      label={mockup.name}
                      disabled={rendering || sending}
                    >
                      {(handle) => (
                        <div
                          role="listitem"
                          data-tile={mockup.id}
                          data-included={image ? "true" : "false"}
                          className={`relative h-full w-full overflow-hidden rounded-md border transition-colors ${
                            marked
                              ? "border-warning opacity-50"
                              : image
                                ? "border-forest bg-forest-soft/20"
                                : "border-border-subtle bg-surface"
                          }`}
                        >
                          <button
                            type="button"
                            className="block w-full text-left disabled:cursor-not-allowed"
                            onClick={() => onTileClick(listing, mockup.id)}
                            onPointerDown={startPress(listing, mockup.id)}
                            onPointerMove={movePress}
                            onPointerUp={releasePress}
                            onPointerLeave={releasePress}
                            onPointerCancel={releasePress}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              beginRemoval(listing, mockup.id);
                            }}
                            disabled={rendering || sending}
                            aria-pressed={Boolean(image)}
                            aria-label={`${image ? "Remove" : "Use"} ${mockup.name} for ${listing.designName}`}
                          >
                            <div className="relative aspect-square overflow-hidden bg-surface-muted">
                              <AssetThumb
                                assetId={entry?.assetId ?? mockup.assetId}
                                className="h-full w-full"
                                alt={mockup.name}
                              />
                              {order > 0 && (
                                <span className="absolute left-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-forest px-1.5 text-xs font-semibold text-white shadow-subtle">
                                  {order}
                                </span>
                              )}
                              {order === 1 && (
                                <span className="absolute right-2 top-2 rounded bg-forest px-1.5 py-0.5 text-xs font-medium text-white">
                                  main
                                </span>
                              )}
                              <span
                                className={
                                  `absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-xs font-medium ${
                                    !image
                                      ? "bg-ink-subtle text-white"
                                      : image.overridden
                                        ? "bg-amber text-white"
                                        : entry
                                          ? entry.source === "mockups"
                                            ? "bg-forest text-white"
                                            : "bg-default text-white"
                                          : "bg-warning text-white"
                                  }`
                                }
                              >
                                {marked
                                  ? "Will be removed"
                                  : !image
                                    ? "Excluded"
                                    : image.overridden
                                      ? "Override: Mockups"
                                      : entry
                                        ? entry.source === "mockups"
                                          ? "From Mockups"
                                          : "Rendered here"
                                        : "Not rendered"}
                              </span>
                            </div>
                          </button>
                          <div className="flex items-center gap-1 p-2">
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <p
                                className="truncate text-xs font-medium text-ink"
                                title={mockup.name}
                              >
                                {mockup.name}
                              </p>
                              <p className="text-xs text-ink-muted">
                                {area ? "Print area mapped" : "No print area"}
                              </p>
                            </div>
                            {handle}
                          </div>
                          {image && image.entry && !image.fresh && !image.adopted && (
                            <div className="flex items-center gap-1 px-2 pb-2">
                              {image.overridden ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => clearTileOverride(listing, mockup.id)}
                                  className="text-xs text-amber hover:bg-amber-soft"
                                >
                                  Clear override
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    lockedListings.has(listing.listingId)
                                      ? setLockedConfirm({
                                          listingName: listing.designName,
                                          apply: () => forceTileOverride(listing, mockup.id),
                                        })
                                      : forceTileOverride(listing, mockup.id)
                                  }
                                  className="text-xs text-amber hover:bg-amber-soft"
                                >
                                  Use Mockups render
                                </Button>
                              )}
                              <span className="text-xs text-ink-muted">
                                {image.overridden
                                  ? "using saved render"
                                  : "saved render is out of date"}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </DraggableTile>
                  );
                })}
              </Reorder.Group>

              {cards.length > 0 && (
                <div className="space-y-1.5 border-t border-border-subtle pt-2">
                  <p className="text-xs text-ink-muted">
                    Info cards attach automatically - the categories of the mockups used in
                    this listing. They are uploaded to Printify after the mockups, in this
                    order. Drag to reorder; a detached design keeps its card order in its own
                    list, like the mockup tiles.
                  </p>
                  <Reorder.Group
                    as="div"
                    axis="x"
                    values={cards.map((card) => card.id)}
                    onReorder={(next) =>
                      ownOrderOn
                        ? updateOwnOrder(listing.listingId, next)
                        : update({ listingImageOrder: mergeGlobalOrder(session, next) })
                    }
                    className="flex gap-3 overflow-x-auto pb-1"
                    role="list"
                    aria-label={`Info cards for ${listing.designName}`}
                  >
                    {cards.map((card, index) => (
                      <DraggableTile
                        key={card.id}
                        value={card.id}
                        label={card.name}
                        disabled={rendering || sending}
                      >
                        {(handle) => (
                          <div
                            role="listitem"
                            data-info-card={card.id}
                            className="relative h-full w-full overflow-hidden rounded-md border border-forest bg-forest-soft/20 transition-colors"
                          >
                            <div className="relative aspect-square overflow-hidden bg-surface-muted">
                              <AssetThumb
                                assetId={card.assetId}
                                className="h-full w-full"
                                alt={card.name}
                              />
                              <span className="absolute left-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-ink px-1.5 text-xs font-semibold text-white shadow-subtle">
                                {selected.length + index + 1}
                              </span>
                              <span className="absolute bottom-2 left-2 rounded bg-ink-subtle px-1.5 py-0.5 text-xs font-medium text-white">
                                Info card
                              </span>
                            </div>
                            <div className="flex items-center gap-1 p-2">
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <p
                                  className="truncate text-xs font-medium text-ink"
                                  title={card.name}
                                >
                                  {card.name}
                                </p>
                                <p className="text-xs text-ink-muted">
                                  after the mockups
                                </p>
                              </div>
                              {handle}
                            </div>
                          </div>
                        )}
                      </DraggableTile>
                    ))}
                  </Reorder.Group>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderRow = (row: "plain" | "ink") => {
    const rowListings = rows[row];
    if (rowListings.length === 0) return null;
    return (
      <section key={row} className="space-y-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <Sparkles className="h-4 w-4 text-forest" />
            {ROW_LABELS[row]}
            <Badge variant="muted">{rowListings.length}</Badge>
          </h2>
          <p className="text-xs text-ink-muted">{ROW_HINTS[row]}</p>
        </div>

        <div className="space-y-4">{rowListings.map(renderListingRow)}</div>
      </section>
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-5 sm:p-8">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <Images className="h-4 w-4 text-forest" /> Listing images
              </h2>
              <p className="text-xs text-ink-muted">
                One row per design; every product mockup is a tile. First tile = main image. Dragging reorders every row until you switch a design&apos;s Own order toggle on, which detaches that row. Long-press to remove. Tiles use saved renders only when current.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void downloadListings(listings, "all")}
                disabled={rendering || sending || freshSelected === 0}
              >
                <Download className="h-3.5 w-3.5" /> Download selected
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void sendToPrintify()}
                disabled={rendering || sending || !canSend}
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Send to Printify
              </Button>
              <Button
                size="sm"
                onClick={() => void renderSelected()}
                disabled={rendering || sending || totalSelected === 0}
              >
                {rendering ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Save & render {totalSelected > 0 ? `(${totalSelected})` : ""}
              </Button>
            </div>
          </div>

          {(rendering || sending) && (
            <div className="space-y-1.5">
              <Progress
                value={
                  rendering && progress.total > 0
                    ? Math.round((progress.done / progress.total) * 100)
                    : sending && sendProgress.total > 0
                      ? Math.round((sendProgress.done / sendProgress.total) * 100)
                      : 0
                }
              />
              <p className="text-xs text-ink-muted" aria-live="polite">
                {rendering
                  ? `${progress.done}/${progress.total} · ${progress.label}`
                  : `${sendProgress.done}/${sendProgress.total} · ${sendProgress.label}`}
              </p>
            </div>
          )}

          {linkableCount > 0 && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-warning/60 bg-warning-soft/40 px-3 py-2"
              role="status"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">
                  {linkableCount} saved render{linkableCount === 1 ? "" : "s"} from Mockups can be
                  linked
                </p>
                <p className="text-xs text-ink-muted">
                  Linking pins the newest saved pixels to these tiles and assumes the design and
                  print area have not changed since you saved them - check the tiles after.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={linkSavedRenders}
                disabled={rendering || sending}
              >
                Link {linkableCount} saved render{linkableCount === 1 ? "" : "s"}
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-muted/60 px-3 py-2">
            <p className="text-xs text-ink-muted">
              <strong>{totalSelected}</strong> image{totalSelected === 1 ? "" : "s"} selected across{" "}
              <strong>{listings.length}</strong> listing{listings.length === 1 ? "" : "s"} ·{" "}
              {freshSelected} current render{freshSelected === 1 ? "" : "s"}
            </p>
            <Button size="sm" variant="ghost" asChild>
              <Link href="/listing-details">Edit titles, tags & prices →</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {listings.length === 0 ? (
        <EmptyState
          icon={<Images />}
          title="No listings yet"
          description="Tick designs in Studio."
          actions={[
            { label: "Go to Designs", onClick: () => navigate("/printify-studio") },
          ]}
        />
      ) : (
        <>
          {renderRow("plain")}
          {renderRow("ink")}
        </>
      )}

      {notInBatch.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <h2 className="text-[15px] font-semibold text-ink">Not in this batch</h2>
            <p className="text-xs text-ink-muted">
              These designs are in the library but are not ticked for the batch, so they have no
              listing here. Add one only when you mean it - nothing is created automatically.
            </p>
            <div className="flex flex-wrap gap-2">
              {notInBatch.map((design) => (
                <div
                  key={design.id}
                  className="flex items-center gap-2 rounded-md border border-border-subtle px-2 py-1"
                >
                  <AssetThumb
                    assetId={design.processedAssetId ?? design.originalAssetId}
                    className="h-6 w-6 rounded"
                    alt={design.name}
                  />
                  <span className="max-w-[180px] truncate text-xs text-ink" title={design.name}>
                    {design.name}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      update({ designIds: [...session.designIds, design.id] })
                    }
                    disabled={rendering || sending}
                  >
                    Add to batch
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={bridgeOpen} onOpenChange={setBridgeOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              <Send className="h-4 w-4" /> Apply the images in Printify
            </DialogTitle>
            <DialogDescription>
              {bridgeSummary
                ? `${bridgeSummary.images} image${
                    bridgeSummary.images === 1 ? "" : "s"
                  } uploaded for ${bridgeSummary.products} product${
                    bridgeSummary.products === 1 ? "" : "s"
                  }. Printify only exposes the mockup selection to its own web session, so the last step runs in your browser tab.`
                : "The payload is ready."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {(bridgeSummary?.failures.length ?? 0) + (bridgeSummary?.skipped.length ?? 0) > 0 && (
              <div className="max-h-24 space-y-1 overflow-y-auto rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
                {bridgeSummary?.failures.map((line) => <p key={line}>{line}</p>)}
                {bridgeSummary?.skipped.map((line) => <p key={line}>{line}</p>)}
              </div>
            )}

            <ol className="grid list-none gap-2 p-0 sm:grid-cols-3">
              <SendStep
                step={1}
                title="Images uploaded"
                detail={`${bridgeSummary?.images ?? 0} custom mockup${
                  (bridgeSummary?.images ?? 0) === 1 ? "" : "s"
                } stored in Printify`}
                done={(bridgeSummary?.images ?? 0) > 0}
              />
              <SendStep
                step={2}
                title={bridgeCopied ? "Payload copied" : "Copy the payload"}
                detail={
                  bridgeCopied
                    ? "On your clipboard - the bookmarklet reads it"
                    : "It lists the uploaded mockups for the product"
                }
                done={bridgeCopied}
              />
              <SendStep
                step={3}
                title={
                  bridgeApplied
                    ? "Mockups applied"
                    : extensionReady
                      ? "Run the extension (one click)"
                      : "Run the bookmarklet once"
                }
                detail={
                  bridgeApplied
                    ? "Printify now has these mockups selected"
                    : extensionReady
                      ? "On your signed-in Printify session, in the background"
                      : "On the product's Printify tab, in your signed-in session"
                }
                done={Boolean(bridgeApplied)}
              />
            </ol>

            {extensionReady && (
              <div className="space-y-1.5 rounded-md border border-forest/40 bg-forest-soft/20 px-3 py-2">
                <p className="text-xs font-medium text-ink">
                  {bridgeApplied ? "Mockups applied" : "Apply in Printify - one click"}
                </p>
                {bridgeApplied ? (
                  <p className="text-xs text-ink-muted">
                    Applied {bridgeApplied.done} of {bridgeApplied.total} product
                    {bridgeApplied.total === 1 ? "" : "s"}. The extension ran inside
                    your own signed-in Printify session and closed the tab. Check the
                    product if you want to reorder the images.
                  </p>
                ) : (
                  <p className="text-xs text-ink-muted">
                    The Printify bridge extension opens the product in a background tab,
                    selects these mockups with your own sign-in, and closes it. Nothing
                    leaves printify.com.
                  </p>
                )}
                {bridgeApplied && bridgeApplied.failures.length > 0 && (
                  <div className="max-h-24 space-y-1 overflow-y-auto rounded-md bg-warning-soft px-2 py-1 text-xs text-warning">
                    {bridgeApplied.failures.map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={applyWithExtension}
                    disabled={extensionApplying || !bridgePayloadData}
                  >
                    {extensionApplying ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {extensionApplying
                      ? "Applying in Printify"
                      : bridgeApplied
                        ? "Apply again"
                        : "Apply in Printify"}
                  </Button>
                  {bridgeApplied && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openPrintify()}
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Open the product to check
                    </Button>
                  )}
                </div>
              </div>
            )}

            {extensionOld && (
              <p className="rounded-md bg-warning-soft px-2 py-1 text-xs text-warning">
                {extensionReloadMessage()}
              </p>
            )}
            <div className="space-y-1.5 rounded-md border border-border-subtle px-3 py-2">
              <p className="text-xs font-medium text-ink">
                {extensionReady ? "Or use the bookmarklet" : "2. Copy the payload"}
              </p>
              <p className="text-xs text-ink-muted">
                Already done when step 2 is ticked. Copy it again if you have copied something
                else since, or open the raw text.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={bridgeCopied ? "outline" : "secondary"}
                  onClick={() => void copyPayload()}
                >
                  {bridgeCopied ? "Copy again" : "Copy payload"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    window.open("/printify-bookmarklet", "_blank", "noopener,noreferrer")
                  }
                >
                  Install guide & copy bookmarklet
                </Button>
              </div>
              <details className="text-xs text-ink-muted">
                <summary className="cursor-pointer select-none">Show the payload text</summary>
                <Textarea
                  readOnly
                  value={bridgePayload}
                  className="mt-1.5 h-24 font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
              </details>
            </div>

            <div className="space-y-1.5 rounded-md border border-border-subtle px-3 py-2">
              <p className="text-xs font-medium text-ink">
                3. Run the bookmarklet on the Printify product
              </p>
              <p className="text-xs text-ink-muted">
                Save the bookmarklet once, open the product in Printify, then click it. It reads
                this payload from the clipboard and uses your own signed-in session, so the images
                become that product&apos;s mockups and the first one is the main image. No token
                leaves printify.com.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button size="sm" variant="ghost" onClick={() => setBridgeOpen(false)}>
              Close
            </Button>
            <Button size="sm" onClick={openPrintify}>
              <ExternalLink className="h-3.5 w-3.5" />
              {bridgeSummary?.firstProductId ? "Open the Printify product" : "Open Printify"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(ownOrderConfirm)}
        onOpenChange={(open) => {
          if (!open) setOwnOrderConfirm(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Discard {ownOrderConfirm?.listingName}&apos;s own order?</DialogTitle>
            <DialogDescription>
              This row is using its own image order, different from the shared one. Switching
              Own order off returns it to the shared order and throws the design&apos;s own
              order away.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOwnOrderConfirm(null)}>
              Keep my order
            </Button>
            <Button
              size="sm"
              onClick={() => {
                ownOrderConfirm?.apply();
                setOwnOrderConfirm(null);
              }}
            >
              Switch to shared order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(lockedConfirm)}
        onOpenChange={(open) => {
          if (!open) setLockedConfirm(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Replace the locked images for {lockedConfirm?.listingName}?</DialogTitle>
            <DialogDescription>
              You locked this listing&apos;s image selection, so the Export Center uses exactly
              the images that are already saved. Replacing them with the Mockups render changes
              what will be exported and sent to Printify. This cannot be undone automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="ghost" onClick={() => setLockedConfirm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                lockedConfirm?.apply();
                setLockedConfirm(null);
              }}
            >
              Replace the images
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
