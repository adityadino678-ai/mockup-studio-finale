"use client";

// ---------------------------------------------------------------------------
// Listing preview.
//
// The third listing page, and the only one that talks to Printify's shop. It
// draws each listing the way Printify's "My products" screen does - a big main
// image, the remaining images under it, and the copy beside them - and then
// offers the two actions that are actually different: SEND (create the draft,
// upload the images, apply the mockup selection, and stop with the product
// updated and unpublished) and PUBLISH (a separate, explicit click).
//
// Three things this page refuses to do, because they are how publishing goes
// wrong:
//
//   1. It never invents an image. The main image is the FIRST image of the
//      listing's effective selection (the same rule as Listing images: the
//      ticked mockups in click order, else every mockup, and an explicit
//      Clear means none), resolved through the session's renders or adopted
//      by fingerprint. A missing render is shown as a dashed "not rendered
//      yet" tile, never as a stand-in photo.
//   2. It never publishes a product it did not create or link for THIS
//      listing. The product id comes from the Studio's own results list (or a
//      product draft written by this app's creation path), keyed by the
//      listing's id - never typed in, never guessed.
//   3. It never retries a publish. The pipeline runs its steps in order, stops
//      at the first failure and shows Printify's own message; running it again
//      is a fresh click through the same confirm dialog.
//
// The step that cannot run from a server is the mockup selection: Printify
// only exposes it to its own web session, so the pipeline pauses there with
// the clipboard payload, the companion extension (one click) and the
// bookmarklet (fallback), exactly like Listing images. The run NEVER chains
// into a publish: applying the selection ends at "updated in Printify", and
// publishing is a second, deliberate click.
//
// The session is read LIVE (the Studio and the agent write the same blob).
// Browsing a preview never changes the batch; the only write is the applied
// mockup signature recorded AFTER an explicit successful apply, so the next
// copy/price-only Send can skip the image stage.
//
// Send has a fast path: when the product already has exactly the selected
// mockups (same order, same render fingerprints, same product id), it updates
// the product copy/price and stops. It does not re-render, re-upload or
// rewrite Printify's selection for a title/tag/price edit.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db, getSetting, setSetting } from "@/lib/db/schema";
import { getAssetBlob, logActivity } from "@/lib/db/repo";
import { authedFetch, loadIntegrations } from "@/lib/client/integrations";
import {
  extensionOutdated,
  extensionReady as companionExtensionReady,
  extensionReloadMessage,
} from "@/lib/client/extension";
import { mockupImageForUpload } from "@/lib/client/mockup-upload";
import { confirmPrintifyProduct } from "@/lib/client/tools";
import { fetchVariants } from "@/lib/printify/catalog-client";
import { Link } from "@/lib/client/nav";
import { AssetThumb } from "@/components/asset-thumb";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/input";
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
  type StudioListing,
} from "@/lib/printify/listing-plan";
import {
  emptySession,
  listingMockupIds,
  listingRenderFor,
  loadSession,
  placementFor,
  priceForListing,
  renderTemplate,
  renderTitle,
  RESULTS_KEY,
  saveSession,
} from "@/lib/printify/studio-session";
import { isListingRenderFresh, listingImageFingerprint } from "@/lib/printify/listing-render";
import {
  appliedMockupRecord,
  listingMockupSignature,
  mockupsAlreadyApplied,
  withAppliedMockups,
} from "@/lib/printify/listing-mockups";
import {
  bridgePayloadJson,
  buildBridgePayload,
  countBridgeImages,
  type PrintifyBridgePayload,
  type PrintifyBridgeProduct,
  type PrintifyMockupUpload,
} from "@/lib/printify/mockup-bridge";
import { buildCatalogueIndex, resolveVariantIds } from "@/lib/printify/variants";
import { normaliseColourGroups } from "@/lib/printify/design-colours";
import type { CatalogVariant } from "@/lib/printify/types";
import { useListingCatalog } from "@/views/listings/listing-catalog";
import {
  adoptedRenderEntry,
  buildAdoptionIndex,
  matchInAdoptionIndex,
} from "@/views/listings/render-adoption";
import { productColourGroups } from "@/views/studio/design-panel";
import type {
  AssetMeta,
  Design,
  ListingDraft,
  Mockup,
  Placement,
  StudioListingMockupsApplied,
  StudioListingRender,
  StudioProductResult,
  StudioSession,
} from "@/types/domain";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  ClipboardCheck,
  ExternalLink,
  Eye,
  Images,
  Loader2,
  Rocket,
  Sparkles,
} from "lucide-react";

/** Printify's own limit on enabled variants per product. */
const MAX_VARIANTS = 100;

/** The upload route accepts 10; the client has always sent 8 at a time. */
const MAX_IMAGES_PER_UPLOAD = 8;

/** One image of a listing's effective selection, with its render state. */
interface SelectedImage {
  mockup: Mockup;
  /** The session's recorded render, whether or not it is still current. */
  entry: StudioListingRender | undefined;
  /** The session entry matches what this listing would render now. */
  fresh: boolean;
  /** A saved render adopted by fingerprint, because it is pixel-identical. */
  adopted: StudioListingRender | undefined;
}

/** A product this app created or linked, for one listing. */
interface LinkedProduct {
  productId: string;
  /**
   * The Printify shop. Absent on older results and on the agent's creation
   * path; the mockup upload endpoint resolves it from the key then.
   */
  shopId?: number;
  /** The title that was actually sent, for the stale-id check. */
  title?: string;
}

/** The copy a listing would be created with, and what the preview shows. */
interface ListingCopy {
  title: string;
  description: string;
  tags: string[];
  category: string;
  quantity: number;
  /** In cents. Meaningful only when `hasPrice`. */
  priceCents: number;
  /**
   * False in the one case the app treats as "no price": custom pricing with
   * no price entered for this listing. `priceForListing` would fall back to
   * the batch fixed price, but Listing details explicitly requires a custom
   * value, so pretending the fallback is this listing's price would price a
   * product the user never priced.
   */
  hasPrice: boolean;
}

/** One line of "What Printify gets". */
interface PreviewCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Where the user fixes it, when it is not OK. */
  href: string;
  action: string;
}

interface UploadResponse {
  shopId?: number;
  productId?: string;
  title?: string;
  uploads?: PrintifyMockupUpload[];
  error?: string;
  detail?: string;
}

/** The update endpoint's answer: the product as Printify now holds it. */
interface UpdateProductResponse {
  product?: { id?: string; title?: string };
  shopId?: number;
  error?: string;
  detail?: string;
}

/** One row of GET /api/printify/shops. */
interface ShopOption {
  id: number;
  title: string;
  salesChannel: string;
  connected: boolean;
}

/** The publish endpoint's response, including its 8254 details. */
interface PublishResponse {
  published?: boolean;
  productId?: string;
  shopId?: number;
  error?: string;
  detail?: string;
  code?: number;
  shopTitle?: string;
  connectUrl?: string;
}

/**
 * A failed publish that carries the shop Printify blames, so the dialog can
 * show the connect link instead of only a sentence.
 */
class PublishFailure extends Error {
  readonly code?: number;
  readonly shop?: { id: number; title: string };
  readonly connectUrl?: string;

  constructor(
    message: string,
    details: { code?: number; shop?: { id: number; title: string }; connectUrl?: string } = {},
  ) {
    super(message);
    this.name = "PublishFailure";
    this.code = details.code;
    this.shop = details.shop;
    this.connectUrl = details.connectUrl;
  }
}

type StepKey = "create" | "images" | "mockups" | "publish";

type StepStatus = "pending" | "running" | "done" | "failed" | "waiting" | "skipped";

interface PipelineStep {
  key: StepKey;
  title: string;
  status: StepStatus;
  detail: string;
}

type PipelinePhase =
  | "confirm"
  | "running"
  | "awaiting-mockups"
  /** The product is updated in Printify and still unpublished. */
  | "updated"
  | "done"
  | "failed";

/** What the user asked this run to do. */
type PipelineIntent = "send" | "publish";

interface PipelineState {
  listingId: string;
  designName: string;
  /** The product this run is about, once one exists or was created. */
  productId?: string;
  /** True when THIS run created the product, which is then the pool of one. */
  createdHere: boolean;
  steps: PipelineStep[];
  phase: PipelinePhase;
  /** Send/update only, or continue to the separate publish click. */
  intent: PipelineIntent;
  /** Printify's own message, verbatim, when the run stopped. */
  error?: string;
  /** The upstream code (8254 = the shop is not connected to a sales channel). */
  errorCode?: number;
  /** The shop a failed publish points at, when there is one. */
  errorShop?: { id: number; title: string };
  /** Where to connect the shop's sales channel. */
  errorConnectUrl?: string;
  /** The clipboard payload built in the mockup-selection step. */
  payload?: string;
  /** The same payload as an object, for the extension's one-click apply. */
  payloadData?: PrintifyBridgePayload;
  /**
   * True when the run skipped the image stage because the listing's mockups
   * were already applied. The dialog explains that only copy/price changed.
   */
  fastPath?: boolean;
  /**
   * What to persist once the apply succeeds: one signature per prepared
   * listing. Recorded at apply time, never at upload time, because an upload
   * alone does not change Printify's selection.
   */
  appliedSignatures?: Record<string, StudioListingMockupsApplied>;
}

/** The extension's per-product answer to one-click apply. */
interface AppliedState {
  done: number;
  total: number;
  failures: string[];
}

/** A listing this session has published, so the page stops asking. */
interface PublishedState {
  productId: string;
  at: number;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Printify's readable error text, unchanged.
 *
 * The endpoint already prefers Printify's own message over the useless
 * "Operation failed.", and forwards the nested detail when there is one. Both
 * are shown as they arrived - a paraphrase is what makes a support thread
 * useless.
 */
function upstreamError(
  data: { error?: string; detail?: string } | null,
  status: number,
): string {
  const error = data?.error?.trim() || `Printify request failed (HTTP ${status}).`;
  const detail = data?.detail?.trim();
  return detail ? `${error} — ${detail}` : error;
}

/**
 * The four steps, in the order the pipeline runs them.
 *
 * The confirm dialog shows this same list, so what the user agrees to and what
 * the run reports are the same plan - not two descriptions of it.
 */
function planSteps(params: {
  linked?: LinkedProduct;
  imageCount: number;
  selectedCount: number;
  intent: PipelineIntent;
}): PipelineStep[] {
  const missing = params.selectedCount - params.imageCount;
  return [
    {
      key: "create",
      title: "Create or update the Printify product",
      status: "pending",
      detail: params.linked
        ? `Update the existing product (${params.linked.productId}) with this listing's current title, description, tags and price. No new product is created, and its print areas and artwork are left alone.`
        : "This listing's title, description, tags, price and print area, through the same creation path the agent's Create product card uses. The product is an UNPUBLISHED draft.",
    },
    {
      key: "images",
      title: "Upload every design's images",
      status: "pending",
      detail:
        params.imageCount === 0
          ? "No selected image has a current render yet."
          : `${params.imageCount} image${params.imageCount === 1 ? "" : "s"} for this listing, plus every other listing that already has a Printify product — in listing order, so the first is the main image.${
              missing > 0
                ? ` ${missing} selected image${missing === 1 ? " has" : "s have"} no current render and will not be uploaded; a shorter set can change which image is the main one, so render them first if they matter.`
                : ""
            }`,
    },
    {
      key: "mockups",
      title: "Select the mockups in Printify",
      status: "pending",
      detail:
        "One payload for the whole batch. Printify only exposes this step to its own web session, so the companion extension applies every product in one click; the clipboard bookmarklet is the fallback. The run pauses here until it is applied.",
    },
    {
      key: "publish",
      title: "Publish the product",
      status: params.intent === "send" ? "skipped" : "pending",
      detail:
        params.intent === "send"
          ? "NOT run. Sending stops with the product updated in Printify and unpublished. Publishing is a separate, explicit click."
          : "POST /api/printify/publish with the documented booleans body. This makes the product live on your shop, and it is never retried automatically.",
    },
  ];
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-forest" />;
  if (status === "done" || status === "skipped")
    return <Check className="h-3.5 w-3.5 text-forest" />;
  if (status === "failed") return <AlertTriangle className="h-3.5 w-3.5 text-danger" />;
  if (status === "waiting") return <CircleDashed className="h-3.5 w-3.5 text-warning" />;
  return <span className="mt-1.5 block h-1.5 w-1.5 rounded-full bg-border-strong" />;
}

export function ListingPreviewView() {
  // --- the library and the batch ---------------------------------------------
  const designs = useLiveQuery(() => db.designs.toArray(), []);
  const mockups = useLiveQuery(() => db.mockups.orderBy("createdAt").toArray(), []);
  const placements = useLiveQuery(() => db.placements.toArray(), []);
  // Every saved render, so an image can ADOPT one whose recorded fingerprint
  // still matches this listing's inputs instead of claiming it is missing.
  const renderAssets = useLiveQuery(
    () => db.assets.where("kind").equals("mockup-render").toArray(),
    [],
  );
  // Local listing drafts: the listing's copy of record. Listing details writes
  // per-listing overrides there, so the preview reads the draft first and
  // falls back to the batch templates - the same seeding rule that page uses.
  const drafts = useLiveQuery(() => db.listingDrafts.toArray(), []);
  // Product drafts: the second record of a created product, written by the
  // agent's confirm card as well as by product creation.
  const productDrafts = useLiveQuery(() => db.productDrafts.toArray(), []);
  // The Studio's results are the PRIMARY link between a listing and a product.
  const results = useLiveQuery(async () => {
    const stored = await getSetting<StudioProductResult[]>(RESULTS_KEY, []);
    return Array.isArray(stored) ? stored : [];
  }, []);
  const catalog = useListingCatalog();

  // Whether Printify has a key at all. The catalogue alone cannot answer this:
  // it is public and can come from the edge cache with no key configured, so a
  // healthy catalogue is not proof that a product can be created or published.
  // `null` means "not known yet", and is treated as unknown rather than as a
  // failure - the endpoints still report their own 503 honestly.
  const [printifyConfigured, setPrintifyConfigured] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authedFetch("/api/integrations/status");
        const data = (await response.json().catch(() => null)) as {
          printify?: { configured?: boolean };
        } | null;
        if (!cancelled) setPrintifyConfigured(Boolean(data?.printify?.configured));
      } catch {
        if (!cancelled) setPrintifyConfigured(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- the saved Printify shop ----------------------------------------------
  // The selection is browser-local (Settings), so it is read from IndexedDB;
  // the shop list itself comes from the read-only endpoint. Publishing to the
  // wrong shop is error 8254, so the preview checks this BEFORE the button.
  const [shops, setShops] = React.useState<ShopOption[] | null>(null);
  const [shopsError, setShopsError] = React.useState<string | null>(null);
  const [savedShopId, setSavedShopId] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await loadIntegrations();
        const saved = config.printifyShopId;
        if (!cancelled) {
          setSavedShopId(
            typeof saved === "number" && Number.isInteger(saved) && saved > 0 ? saved : null,
          );
        }
        const response = await authedFetch("/api/printify/shops");
        const data = (await response.json().catch(() => null)) as
          | { shops?: ShopOption[]; error?: string }
          | null;
        if (cancelled) return;
        if (!response.ok) {
          setShops([]);
          setShopsError(
            data?.error ?? `Could not read the Printify shops (HTTP ${response.status}).`,
          );
          return;
        }
        setShops(Array.isArray(data?.shops) ? data.shops : []);
        setShopsError(null);
      } catch (error) {
        if (!cancelled) {
          setShops([]);
          setShopsError(
            error instanceof Error ? error.message : "Could not read the Printify shops",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** The shop saved in Settings, when it still exists on the account. */
  const selectedShop = React.useMemo(
    () => (shops ?? []).find((shop) => shop.id === savedShopId),
    [shops, savedShopId],
  );

  /**
   * The shop this page would actually publish to.
   *
   * It is ONLY the saved selection. Falling back to the first connected shop
   * here would make the UI name a store the user never chose, while the
   * preflight correctly refuses to run without a selection.
   */
  const targetShop = React.useMemo(() => {
    if (!shops || savedShopId == null) return undefined;
    return selectedShop;
  }, [shops, savedShopId, selectedShop]);

  const shopBlockedReason = React.useMemo((): string | null => {
    if (shopsError) {
      return `The Printify shop list could not be read: ${shopsError}`;
    }
    // Do not let a run start before the target shop is verified: the check is
    // the whole point of this page's preflight.
    if (shops === null) return "Reading the Printify shop list…";
    if (savedShopId == null) {
      return "No Printify shop is selected. Choose the shop to publish to in Settings.";
    }
    if (!selectedShop) {
      return `The saved Printify shop (#${savedShopId}) is not in this account's shop list. Refresh the list in Settings and choose a shop again.`;
    }
    if (!selectedShop.connected) {
      return `Shop "${selectedShop.title}" (#${selectedShop.id}) is not connected to a sales channel (Etsy). Publishing to it fails with error 8254 — connect it in Printify, or choose a connected shop in Settings.`;
    }
    return null;
  }, [shops, shopsError, savedShopId, selectedShop]);

  // Live, not one-shot: the Studio, the Mockups panel and the agent all write
  // the same blob, and a preview that contradicts them would be a lie.
  const liveSession = useLiveQuery(() => loadSession(), []);
  const [session, setSession] = React.useState<StudioSession>(() => emptySession());

  React.useEffect(() => {
    if (liveSession) setSession(liveSession);
  }, [liveSession]);

  // --- the product's variants (creation only) --------------------------------
  // Creating a product needs variant ids, and they only exist in the
  // catalogue. This is the same endpoint the Studio loads; the edge cache
  // makes a revisit cheap. A failure is reported only where it matters - next
  // to the create step - so an unconfigured key does not make the preview look
  // broken.
  const [variants, setVariants] = React.useState<CatalogVariant[]>([]);
  const [variantsLoading, setVariantsLoading] = React.useState(false);
  const [variantsError, setVariantsError] = React.useState<string | null>(null);
  const blueprintId = session.blueprintId;
  const printProviderId = session.printProviderId;

  React.useEffect(() => {
    if (!blueprintId || !printProviderId) {
      setVariants([]);
      setVariantsError(null);
      setVariantsLoading(false);
      return;
    }
    let cancelled = false;
    setVariantsLoading(true);
    setVariantsError(null);
    fetchVariants(blueprintId, printProviderId)
      .then((rows) => {
        if (!cancelled) setVariants(rows);
      })
      .catch((error) => {
        if (cancelled) return;
        setVariants([]);
        setVariantsError(
          error instanceof Error ? error.message : "Could not load the product's variants",
        );
      })
      .finally(() => {
        if (!cancelled) setVariantsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [blueprintId, printProviderId]);

  // --- the listings ----------------------------------------------------------
  const listings = React.useMemo(
    () => buildStudioListings((designs ?? []) as Design[], session),
    [designs, session],
  );
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const activeListing = React.useMemo(
    () => listings.find((listing) => listing.listingId === activeId) ?? listings[0],
    [listings, activeId],
  );

  const productName = React.useMemo(
    () => catalogProductName(catalog.blueprints, session.blueprintId),
    [catalog.blueprints, session.blueprintId],
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
  const draftsByListing = React.useMemo(() => {
    const map = new Map<string, ListingDraft>();
    for (const draft of drafts ?? []) {
      const listingId = draft.designId;
      if (!listingId) continue;
      const existing = map.get(listingId);
      // Newest wins, matching how saveStudioListingDrafts picks the row it
      // re-saves (updatedAt, never createdAt).
      if (!existing || draft.updatedAt >= existing.updatedAt) map.set(listingId, draft);
    }
    return map;
  }, [drafts]);
  const productsByListing = React.useMemo(() => {
    const map = new Map<string, LinkedProduct>();
    // Newest first: re-creating a listing after a failure writes a NEW result
    // for the same design, and that new product is the one this page may
    // publish. Relying on the stored order alone would pick the stale one if a
    // different surface ever appended instead of prepended.
    const newestFirst = [...(results ?? [])].sort((a, b) => b.createdAt - a.createdAt);
    for (const result of newestFirst) {
      // A failed creation can still carry the remote id (wrong artwork); it is
      // NOT a product this page may publish.
      if (result.status !== "created" || !result.remoteProductId) continue;
      if (map.has(result.designId)) continue;
      map.set(result.designId, {
        productId: result.remoteProductId,
        shopId: result.shopId,
        title: result.title,
      });
    }
    // Fall back to the product draft table, newest first: a product created
    // through the agent's confirm card writes a draft but no Studio result.
    const linkedDrafts = (productDrafts ?? [])
      .filter((draft) => draft.status === "created-remote" && !!draft.remoteProductId)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const draft of linkedDrafts) {
      if (!draft.designId || map.has(draft.designId) || !draft.remoteProductId) continue;
      map.set(draft.designId, {
        productId: draft.remoteProductId,
        shopId: draft.remoteShopId,
        title: draft.name,
      });
    }
    return map;
  }, [results, productDrafts]);

  /** Every mockup in library order - the default selection, as on Listing images. */
  const allMockupIds = React.useMemo(
    () => (mockups ?? []).map((mockup) => mockup.id),
    [mockups],
  );
  const adoptionIndex = React.useMemo(
    () => buildAdoptionIndex((renderAssets ?? []) as AssetMeta[]),
    [renderAssets],
  );

  /**
   * The listing's effective image selection.
   *
   * Identical to Listing images, deliberately: an explicit list wins, an
   * explicit Clear means none, and a listing that was never configured starts
   * with every mockup. The preview must not have its own idea of the order,
   * because the first id IS the main image of the product.
   */
  const effectiveIdsFor = React.useCallback(
    (listing: StudioListing): string[] => {
      const configured = session.listingImages?.[listing.listingId] !== undefined;
      if (configured) {
        return listingMockupIds(session, listing.listingId).filter((id) => mockupsById.has(id));
      }
      if (session.listingImageCleared?.[listing.listingId] === true) return [];
      return allMockupIds;
    },
    [session, mockupsById, allMockupIds],
  );

  /** The render this listing would send now: the session's, else an adopted one. */
  const currentEntry = React.useCallback(
    (image: SelectedImage): StudioListingRender | undefined =>
      image.fresh && image.entry ? image.entry : image.adopted,
    [],
  );

  const selectionFor = React.useCallback(
    (listing: StudioListing): SelectedImage[] =>
      effectiveIdsFor(listing)
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
          return {
            mockup,
            entry,
            fresh,
            adopted: adoptedAsset
              ? adoptedRenderEntry({
                  asset: adoptedAsset,
                  fingerprint,
                  designId: listing.designId,
                  mockupId: mockup.id,
                })
              : undefined,
          };
        }),
    [session, mockupsById, placementsByKey, effectiveIdsFor, adoptionIndex],
  );

  /**
   * The signature of what this listing would upload right now.
   *
   * Undefined when any selected image has no current render: a partial set is
   * never sent, and it must never look "already applied" either.
   */
  const signatureFor = React.useCallback(
    (listing: StudioListing, productId: string): string | undefined => {
      const images: Array<{ mockupId: string; fingerprint: string }> = [];
      for (const image of selectionFor(listing)) {
        const entry = currentEntry(image);
        if (!entry) return undefined;
        images.push({ mockupId: image.mockup.id, fingerprint: entry.fingerprint });
      }
      if (images.length === 0) return undefined;
      return listingMockupSignature(productId, images);
    },
    [selectionFor, currentEntry],
  );

  /**
   * True when the product already has exactly these images applied.
   *
   * This is the fast-path guard: a copy/price-only Send can stop after the
   * product PUT instead of re-rendering, re-uploading and rewriting the
   * selection. A missing record falls back to the full path.
   */
  const mockupsCurrentFor = React.useCallback(
    (listing: StudioListing, productId: string): boolean =>
      mockupsAlreadyApplied(
        session,
        listing.listingId,
        productId,
        signatureFor(listing, productId),
      ),
    [session, signatureFor],
  );

  // --- the copy --------------------------------------------------------------
  const copyFor = React.useCallback(
    (listing: StudioListing): ListingCopy => {
      const draft = draftsByListing.get(listing.listingId);
      const title =
        draft?.title ?? renderTitle(session.titleTemplate, listing.designName, productName);
      const description =
        draft?.description ??
        renderTemplate(session.descriptionTemplate, listing.designName, productName, "", 5000);
      const tags = draft ? (draft.tags ?? []) : (session.tags ?? []);
      const customMissing =
        session.priceMode === "custom" &&
        !((session.listingPrices?.[listing.listingId] ?? 0) > 0);
      const priceCents = priceForListing(session, listing.listingId);
      return {
        title,
        description,
        tags,
        category: (draft?.category ?? session.category ?? "").trim(),
        quantity:
          draft?.quantity && draft.quantity > 0
            ? draft.quantity
            : session.quantity && session.quantity > 0
              ? Math.round(session.quantity)
              : 1,
        priceCents,
        hasPrice: !customMissing && Number.isFinite(priceCents) && priceCents > 0,
      };
    },
    [session, draftsByListing, productName],
  );

  // --- colour and variant facts ----------------------------------------------
  const colourCounts = React.useMemo(() => {
    const groups = normaliseColourGroups(productColourGroups(session));
    return {
      plain: groups.plain.length,
      ink: groups.ink.length,
      black: groups.black.length,
      all: [...new Set([...groups.plain, ...groups.ink])],
    };
  }, [session]);

  const variantPlan = React.useMemo((): { ids: number[]; error?: string } => {
    if (!blueprintId || !printProviderId) {
      return { ids: [], error: "Choose a product in the Printify Studio first." };
    }
    if (variantsLoading) return { ids: [], error: "Reading the product's variants…" };
    if (variantsError) return { ids: [], error: variantsError };
    return {
      ids: resolveVariantIds(buildCatalogueIndex(variants), colourCounts.all, session.sizes),
    };
  }, [blueprintId, printProviderId, variantsLoading, variantsError, variants, colourCounts, session.sizes]);

  // --- what stops a publish --------------------------------------------------
  /**
   * The reasons the button is off, in the user's words.
   *
   * These are the same conditions the pipeline enforces again, so a stale
   * render or a deleted product cannot slip through a disabled attribute that
   * stopped being true a second ago.
   */
  const blockersFor = React.useCallback(
    (listing: StudioListing): string[] => {
      const copy = copyFor(listing);
      const selected = selectionFor(listing);
      const current = selected.filter((image) => Boolean(currentEntry(image)));
      const linked = productsByListing.get(listing.listingId);
      const blockers: string[] = [];

      if (printifyConfigured === false) {
        blockers.push(
          "Printify is not configured. Paste your API key in Settings before publishing.",
        );
      } else if (!catalog.configured) {
        blockers.push(
          `Printify could not be reached${
            catalog.error ? ` (${catalog.error})` : ""
          }. Check the key in Settings.`,
        );
      }
      if (printifyConfigured !== false && shopBlockedReason) {
        blockers.push(shopBlockedReason);
      }
      if (!copy.title.trim()) blockers.push("Add a title on Listing details.");
      if (!copy.description.trim()) blockers.push("Add a description on Listing details.");
      if (!copy.hasPrice) blockers.push("Set a price on Listing details.");
      if (current.length === 0) {
        blockers.push(
          selected.length === 0
            ? "This listing has no images selected on Listing images."
            : "No selected image has a current render yet — render them on Listing images.",
        );
      }
      if (!linked) {
        if (listing.partnerName) {
          // One pair is ONE product, and only the Studio builds both artwork
          // groups (the black half's for the plain/black-ink colours, the
          // white half's for the rest). Creating it from this page would print
          // one half's artwork on the other half's colours.
          blockers.push(
            `This pair has no Printify product yet. Create it once on the Printify Studio's Design panel, which builds both halves' artwork, then publish it here.`,
          );
        } else if (listing.row === "ink") {
          // An unpaired ink design is the same problem with one artwork: it
          // needs a print-area group for its main artwork and one for its ink
          // artwork. This page's creation path takes a single artwork, so it
          // would print the main artwork on the ink colours.
          blockers.push(
            `This design prints ink artwork on some colours. Create its Printify product once on the Printify Studio's Design panel, which builds the ink artwork groups, then publish it here.`,
          );
        } else if (variantPlan.error) {
          blockers.push(variantPlan.error);
        } else if (variantPlan.ids.length === 0) {
          blockers.push(
            "No variants match the session's colours and sizes — choose them in the Printify Studio.",
          );
        } else if (variantPlan.ids.length > MAX_VARIANTS) {
          blockers.push(
            `The session selects ${variantPlan.ids.length} variants and Printify allows ${MAX_VARIANTS} per product.`,
          );
        }
      }
      return blockers;
    },
    [copyFor, selectionFor, currentEntry, productsByListing, catalog, printifyConfigured, variantPlan, shopBlockedReason],
  );

  const checksFor = React.useCallback(
    (listing: StudioListing): PreviewCheck[] => {
      const copy = copyFor(listing);
      const selected = selectionFor(listing);
      const current = selected.filter((image) => Boolean(currentEntry(image)));
      const linked = productsByListing.get(listing.listingId);
      const mainImage = current[0];
      return [
        {
          key: "title",
          label: "Title",
          ok: copy.title.trim().length > 0,
          detail: copy.title.trim()
            ? `${copy.title.length} of 140 characters`
            : "Empty — Printify would receive an untitled draft.",
          href: "/listing-details",
          action: "Edit the title",
        },
        {
          key: "description",
          label: "Description",
          ok: copy.description.trim().length > 0,
          detail: copy.description.trim()
            ? `${copy.description.trim().length} characters, line breaks kept`
            : "Empty — a shopper would see no copy at all.",
          href: "/listing-details",
          action: "Write the description",
        },
        {
          key: "tags",
          label: "Tags",
          ok: copy.tags.length > 0,
          detail:
            copy.tags.length > 0
              ? `${copy.tags.length} of 13 tags`
              : "None — the product is still valid, but it cannot be searched by tag.",
          href: "/listing-details",
          action: "Add tags",
        },
        {
          key: "price",
          label: "Price",
          ok: copy.hasPrice,
          detail: copy.hasPrice
            ? `${formatCents(copy.priceCents)} on every variant`
            : "No price set — custom pricing needs a value for this listing.",
          href: "/listing-details",
          action: "Set the price",
        },
        {
          key: "images",
          label: "Images",
          ok: selected.length > 0 && current.length === selected.length,
          detail:
            selected.length === 0
              ? "No images selected — the product would have no photos."
              : `${current.length} of ${selected.length} selected image${
                  selected.length === 1 ? "" : "s"
                } have a current render${
                  mainImage ? ` · "${mainImage.mockup.name}" is the main image` : ""
                }`,
          href: "/listing-images",
          action: "Render the images",
        },
        {
          key: "variants",
          label: "Variants",
          ok: linked ? true : variantPlan.ids.length > 0 && variantPlan.ids.length <= MAX_VARIANTS,
          detail: linked
            ? `Already on Printify (${linked.productId}) — the variants were fixed when the draft was created.`
            : variantPlan.error
              ? variantPlan.error
              : variantPlan.ids.length === 0
                ? "No variants match the session's colours and sizes."
                : `${variantPlan.ids.length} variants from ${colourCounts.all.length} colour${
                    colourCounts.all.length === 1 ? "" : "s"
                  } × ${session.sizes.length || "all"} size${session.sizes.length === 1 ? "" : "s"}${
                    variantPlan.ids.length > MAX_VARIANTS
                      ? ` — Printify allows at most ${MAX_VARIANTS}.`
                      : ""
                  }`,
          href: "/printify-studio",
          action: "Fix the variants",
        },
        {
          key: "shop",
          label: "Shop",
          ok: !shopBlockedReason && Boolean(targetShop?.connected),
          detail: shopBlockedReason
            ? shopBlockedReason
            : targetShop
              ? `${targetShop.title || "Untitled shop"} (#${targetShop.id}) — ${
                  targetShop.connected
                    ? targetShop.salesChannel
                      ? `connected to ${targetShop.salesChannel}`
                      : "connected to a sales channel"
                    : "not connected"
                }`
              : "Reading the Printify shop list…",
          href: "/settings",
          action: "Choose the shop",
        },
      ];
    },
    [
      copyFor,
      selectionFor,
      currentEntry,
      productsByListing,
      variantPlan,
      colourCounts,
      session.sizes,
      shopBlockedReason,
      targetShop,
    ],
  );

  // --- the publish run -------------------------------------------------------
  const [pipeline, setPipeline] = React.useState<PipelineState | null>(null);
  const [publishing, setPublishing] = React.useState(false);
  const [published, setPublished] = React.useState<Record<string, PublishedState>>({});
  // A ref, not just `publishing`: two clicks in one frame would both read the
  // pre-render state. One run at a time is what keeps the publish POST single.
  const inFlight = React.useRef(false);

  // --- the companion extension ----------------------------------------------
  // It only ever applies the mockup SELECTION with the user's own Printify
  // session. It has no publish call, and this page never turns its answer into
  // one: a successful apply ends at "updated in Printify", unpublished.
  const [extensionReady, setExtensionReady] = React.useState(false);
  /** An old build is present but merges instead of replacing, so it is not used. */
  const [extensionOld, setExtensionOld] = React.useState(false);
  const [extensionApplying, setExtensionApplying] = React.useState(false);
  const [applied, setApplied] = React.useState<AppliedState | null>(null);
  const applyRequestId = React.useRef<string | null>(null);
  /** Lets the listener (created once) call the current mark function. */
  const markAppliedRef = React.useRef<() => void>(() => {});

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
      setApplied({ done, total: results.length, failures });
      if (results.length > 0 && failures.length === 0) {
        toast.success(`Applied ${done} product${results.length === 1 ? "" : "s"} in Printify.`);
        // Updated in Printify only. Publishing stays a separate click.
        markAppliedRef.current();
      } else if (failures.length > 0) {
        // Never advance on a partial apply: the product would keep some of
        // Printify's generated mockups, and publishing it would put them live.
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
      setApplied(null);
      toast.error(detail.error ?? "The extension could not apply the images.");
    };
    window.addEventListener("mockup-studio:apply-result", onResult as EventListener);
    window.addEventListener("mockup-studio:apply-error", onError as EventListener);
    return () => {
      window.removeEventListener("mockup-studio:apply-result", onResult as EventListener);
      window.removeEventListener("mockup-studio:apply-error", onError as EventListener);
    };
  }, []);

  const patchStep = (key: StepKey, patch: Partial<PipelineStep>) => {
    setPipeline((prev) =>
      prev
        ? {
            ...prev,
            steps: prev.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
          }
        : prev,
    );
  };

  const failRun = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const failure = error instanceof PublishFailure ? error : null;
    setPipeline((prev) =>
      prev
        ? {
            ...prev,
            phase: "failed",
            error: message,
            errorCode: failure?.code,
            errorShop: failure?.shop,
            errorConnectUrl: failure?.connectUrl,
            // The step that was running is the one that failed: the steps
            // before it stay done, and nothing after it ran.
            steps: prev.steps.map((step) =>
              step.status === "running" ? { ...step, status: "failed", detail: message } : step,
            ),
          }
        : prev,
    );
  };

  /**
   * Records a product this page created, so every other surface agrees.
   *
   * Bookkeeping only: the product exists on Printify either way, so a failed
   * local write is reported as a note, never as a failed publish.
   */
  const rememberProduct = async (
    listing: StudioListing,
    title: string,
    productId: string,
    shopId?: number,
  ) => {
    try {
      const stored = await getSetting<StudioProductResult[]>(RESULTS_KEY, []);
      const list = Array.isArray(stored) ? stored : [];
      const record: StudioProductResult = {
        designId: listing.listingId,
        title,
        designName: listing.designName,
        status: "created",
        remoteProductId: productId,
        createdAt: Date.now(),
        shopId,
      };
      await setSetting(
        RESULTS_KEY,
        [record, ...list.filter((entry) => entry.designId !== listing.listingId)].slice(0, 200),
      );
    } catch {
      toast.message(
        `Created ${productId}. The local product list could not be updated, so Listing images may still ask you to create it.`,
      );
    }
  };

  /**
   * Pushes the listing's current copy to an EXISTING Printify product.
   *
   * The same Send click does this before uploading images, so a draft created
   * earlier stops showing stale copy. It sends only title/description/tags and
   * the price; the endpoint resolves the product's real shop and echoes every
   * variant back, so print areas and enabled variants are not rewritten.
   */
  const updateListingProduct = async (params: {
    productId: string;
    shopId?: number;
    copy: ListingCopy;
  }): Promise<{ shopId?: number; title?: string }> => {
    const response = await authedFetch("/api/printify/products", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        productId: params.productId,
        shopId: params.shopId,
        title: params.copy.title,
        description: params.copy.description,
        tags: params.copy.tags,
        // A listing with no price is blocked before this runs, but never send
        // a zero: Printify would reject the whole update.
        ...(params.copy.hasPrice ? { price: params.copy.priceCents } : {}),
      }),
    });
    const data = (await response.json().catch(() => null)) as UpdateProductResponse | null;
    if (!response.ok) throw new Error(upstreamError(data, response.status));
    return {
      shopId: typeof data?.shopId === "number" ? data.shopId : params.shopId,
      title:
        typeof data?.product?.title === "string" ? data.product.title : params.copy.title,
    };
  };

  /** Uploads the listing's current renders, in order, in chunks of eight. */
  const uploadListingImages = async (params: {
    listing: StudioListing;
    images: SelectedImage[];
    productId: string;
    shopId?: number;
    expectedTitle?: string;
  }): Promise<{ uploads: PrintifyMockupUpload[]; shopId: number; title?: string }> => {
    const uploads: PrintifyMockupUpload[] = [];
    let shopId = params.shopId;
    let title = params.expectedTitle;

    for (let start = 0; start < params.images.length; start += MAX_IMAGES_PER_UPLOAD) {
      const chunk = params.images.slice(start, start + MAX_IMAGES_PER_UPLOAD);
      patchStep("images", {
        status: "running",
        detail: `Uploading ${Math.min(start + chunk.length, params.images.length)} of ${
          params.images.length
        }…`,
      });

      const payloadImages: Array<{ base64: string; filename: string }> = [];
      for (const image of chunk) {
        const entry = currentEntry(image);
        const blob = entry ? await getAssetBlob(entry.assetId) : null;
        if (!blob) throw new Error(`${image.mockup.name} has no stored render`);
        payloadImages.push(
          await mockupImageForUpload(blob, `${params.listing.designName}-${image.mockup.name}`),
        );
      }

      // Exactly the payload Listing images sends: same route, same fields, so
      // the two paths cannot upload differently.
      const response = await authedFetch("/api/printify/mockups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          shopId,
          productId: params.productId,
          expectedTitle: title,
          images: payloadImages,
        }),
      });
      const data = (await response.json().catch(() => null)) as UploadResponse | null;
      if (!response.ok) {
        throw new Error(upstreamError(data, response.status));
      }
      if (!Array.isArray(data?.uploads) || data.uploads.length !== chunk.length) {
        throw new Error("Printify did not return one custom mockup per image.");
      }
      uploads.push(...data.uploads);
      shopId = data.shopId ?? shopId;
      title = data.title ?? title;
    }

    if (shopId == null || !Number.isFinite(shopId) || shopId <= 0) {
      throw new Error("Printify did not return the shop for this product.");
    }
    return { uploads, shopId, title };
  };

  const openConfirm = (intent: PipelineIntent) => {
    if (!activeListing || publishing || inFlight.current) return;
    if (published[activeListing.listingId]) return;
    if (blockersFor(activeListing).length > 0) return;
    const listing = activeListing;
    const selected = selectionFor(listing);
    const current = selected.filter((image) => Boolean(currentEntry(image)));
    const linked = productsByListing.get(listing.listingId);
    setApplied(null);
    setExtensionApplying(false);
    applyRequestId.current = null;
    setPipeline({
      listingId: listing.listingId,
      designName: listing.designName,
      productId: linked?.productId,
      createdHere: false,
      steps: planSteps({
        linked,
        imageCount: current.length,
        selectedCount: selected.length,
        intent,
      }),
      phase: "confirm",
      intent,
    });
  };

  const closePipeline = () => {
    // A run in flight owns the dialog: closing it would hide a failure the
    // user has to see (and the publish step must never happen unwatched).
    if (publishing || extensionApplying) return;
    setPipeline(null);
  };

  /**
   * Steps (a) and (b), then the pause for the bookmarklet.
   *
   * Everything here is one click away from the confirm dialog above; nothing
   * runs from an effect, a timer or a retry.
   */
  const startRun = async () => {
    if (!pipeline || pipeline.phase !== "confirm" || publishing || inFlight.current) return;
    const listing = listings.find((entry) => entry.listingId === pipeline.listingId);
    if (!listing) {
      failRun(new Error("That listing left the batch while the dialog was open."));
      return;
    }
    const copy = copyFor(listing);
    const linked = productsByListing.get(listing.listingId);

    inFlight.current = true;
    setPublishing(true);
    setPipeline((prev) => (prev ? { ...prev, phase: "running" } : prev));
    try {
      let productId = linked?.productId;
      // The selected shop is the preferred shop. `/api/printify/products` reads
      // it from the same saved selection through `x-printify-shop`, so the
      // creation path and this request address one shop.
      let shopId = selectedShop?.id ?? linked?.shopId;
      let productTitle = linked?.title;
      let createdHere = false;

      // (a) create the draft, only when this listing has no product.
      if (!productId) {
        patchStep("create", { status: "running" });
        if (!session.blueprintId || !session.printProviderId) {
          throw new Error(
            "The Printify Studio has no product selected, so a draft cannot be created.",
          );
        }
        if (variantPlan.error) throw new Error(variantPlan.error);
        if (variantPlan.ids.length === 0) {
          throw new Error("No variants match the session's colours and sizes.");
        }
        if (variantPlan.ids.length > MAX_VARIANTS) {
          throw new Error(
            `The session selects ${variantPlan.ids.length} variants and Printify allows ${MAX_VARIANTS}.`,
          );
        }

        const created = await confirmPrintifyProduct({
          designId: listing.designId,
          blueprintId: session.blueprintId,
          printProviderId: session.printProviderId,
          price: copy.priceCents,
          variantIds: variantPlan.ids,
          title: copy.title,
          description: copy.description,
          tags: copy.tags,
          printArea: placementFor(session, listing.designId).position,
          ink: "main",
        });
        const createdResult = created.result as { productId?: string } | undefined;
        if (created.error || !createdResult?.productId) {
          throw new Error(created.error ?? created.summary);
        }
        productId = createdResult.productId;
        // The title that was just sent. It lets the upload route run its
        // stale-product check on the draft this run created, not only on one
        // that already existed.
        productTitle = copy.title;
        createdHere = true;
        await rememberProduct(listing, copy.title, productId, shopId);
        patchStep("create", {
          status: "done",
          detail: `Created draft ${productId} in shop ${shopId ?? "resolved by Printify"} — still unpublished.`,
        });
      } else {
        // The product already exists: Send updates its copy instead of
        // creating a second product. This is what makes edits made after the
        // draft was created (title, description, tags, price) reach Printify.
        patchStep("create", {
          status: "running",
          detail: `Updating ${productId}: title, description, tags${
            copy.hasPrice ? " and price" : ""
          }. No new product is created.`,
        });
        const updated = await updateListingProduct({ productId, shopId, copy });
        shopId = updated.shopId ?? shopId;
        // The title is part of the update, so the upload route's stale-title
        // check must compare against the NEW title, not the one from before.
        productTitle = updated.title ?? copy.title ?? productTitle;
        patchStep("create", {
          status: "done",
          detail: `Updated product ${productId} in shop ${
            shopId ?? "resolved by Printify"
          } — copy and price only; print areas and artwork were not touched.`,
        });
      }

      /*
       * The fast path: the product exists and this exact selection (ordered
       * mockups + render fingerprints) is already applied. A title, tag or
       * price edit must not re-render, re-upload or rewrite Printify's
       * selection. The product PUT above is the whole job.
       *
       * A new product, a changed image/order, or no recorded apply falls
       * through to the full batch path below.
       */
      if (!createdHere && mockupsCurrentFor(listing, productId)) {
        patchStep("images", {
          status: "skipped",
          detail:
            "Skipped — the selected images and their renders are unchanged since the last apply. Nothing was uploaded.",
        });
        patchStep("mockups", {
          status: "skipped",
          detail:
            "Skipped — Printify already has this exact mockup selection from the last apply.",
        });
        patchStep("publish", {
          status: pipeline.intent === "publish" ? "pending" : "skipped",
          detail:
            "Not run. The product is updated in Printify and still unpublished — publishing is the separate button below.",
        });
        setPipeline((prev) =>
          prev
            ? {
                ...prev,
                phase: "updated",
                productId,
                createdHere: false,
                fastPath: true,
                payload: undefined,
                payloadData: undefined,
              }
            : prev,
        );
        toast.success(
          "Updated in Printify. The mockups were already current, so no images were re-uploaded.",
        );
        return;
      }

      // (b) upload this listing's current renders.
      const selected = selectionFor(listing);
      const images = selected.filter((image) => Boolean(currentEntry(image)));
      if (images.length === 0) {
        throw new Error("No selected image has a current render, so there is nothing to upload.");
      }
      const uploaded = await uploadListingImages({
        listing,
        images,
        productId,
        shopId,
        expectedTitle: productTitle,
      });
      shopId = uploaded.shopId;
      // Keep the stale-id guard alive for the next chunk even if a response
      // omitted the title; never replace a known title with `undefined`.
      productTitle = uploaded.title ?? productTitle;
      // (c) The mockup selection is ONE payload for the whole batch, exactly
      // like Listing images' Send. The active listing was uploaded above; every
      // other listing that already has a Printify product is uploaded here too,
      // so one extension click applies every design's mockups. A listing with
      // no product, no current render, or a partial render set is skipped with
      // its reason - it is never sent a shorter selection.
      const appliedSignatures: Record<string, StudioListingMockupsApplied> = {};
      const activeSignature = signatureFor(listing, productId);
      if (activeSignature) {
        appliedSignatures[listing.listingId] = appliedMockupRecord(
          productId,
          selectionFor(listing).flatMap((image) => {
            const entry = currentEntry(image);
            return entry
              ? [{ mockupId: image.mockup.id, fingerprint: entry.fingerprint }]
              : [];
          }),
        );
      }
      const prepared: PrintifyBridgeProduct[] = [
        {
          shopId: uploaded.shopId,
          productId,
          productTitle: productTitle ?? copy.title,
          uploads: uploaded.uploads,
        },
      ];
      const skipped: string[] = [];
      const included = new Set<string>([productId]);
      for (const other of listings) {
        if (other.listingId === listing.listingId) continue;
        const linkedOther = productsByListing.get(other.listingId);
        if (!linkedOther?.productId) {
          skipped.push(`${other.designName}: create the Printify product first`);
          continue;
        }
        if (included.has(linkedOther.productId)) continue;
        const otherSelected = selectionFor(other);
        const otherImages = otherSelected.filter((image) => Boolean(currentEntry(image)));
        if (otherImages.length === 0) {
          skipped.push(`${other.designName}: no current renders selected`);
          continue;
        }
        if (otherImages.length < otherSelected.length) {
          skipped.push(
            `${other.designName}: render all ${otherSelected.length} selected images first`,
          );
          continue;
        }
        try {
          const otherUploaded = await uploadListingImages({
            listing: other,
            images: otherImages,
            productId: linkedOther.productId,
            shopId: linkedOther.shopId,
            expectedTitle: linkedOther.title,
          });
          included.add(linkedOther.productId);
          const otherSignature = signatureFor(other, linkedOther.productId);
          if (otherSignature) {
            appliedSignatures[other.listingId] = appliedMockupRecord(
              linkedOther.productId,
              otherImages.flatMap((image) => {
                const entry = currentEntry(image);
                return entry
                  ? [{ mockupId: image.mockup.id, fingerprint: entry.fingerprint }]
                  : [];
              }),
            );
          }
          prepared.push({
            shopId: otherUploaded.shopId,
            productId: linkedOther.productId,
            productTitle: otherUploaded.title ?? linkedOther.title ?? other.designName,
            uploads: otherUploaded.uploads,
          });
        } catch (error) {
          skipped.push(
            `${other.designName}: ${error instanceof Error ? error.message : "upload failed"}`,
          );
        }
      }

      const payload = buildBridgePayload(prepared);
      const json = bridgePayloadJson(payload);
      const imageCount = countBridgeImages(payload);
      patchStep("images", {
        status: "done",
        detail: `${imageCount} image${imageCount === 1 ? "" : "s"} uploaded across ${
          prepared.length
        } product${prepared.length === 1 ? "" : "s"}.${
          skipped.length > 0
            ? ` Skipped: ${skipped.slice(0, 3).join("; ")}${
                skipped.length > 3 ? ` and ${skipped.length - 3} more` : ""
              }.`
            : ""
        }`,
      });
      patchStep("mockups", {
        status: "waiting",
        detail: `Payload ready — ${imageCount} image${
          imageCount === 1 ? "" : "s"
        } for ${prepared.length} product${prepared.length === 1 ? "" : "s"}. ${
          extensionReady
            ? "Apply it with the extension (one click), then continue."
            : "Run the bookmarklet, then continue."
        }`,
      });
      if (skipped.length > 0) {
        toast.warning(
          `${skipped.length} listing${skipped.length === 1 ? "" : "s"} skipped: ${skipped
            .slice(0, 2)
            .join("; ")}${skipped.length > 2 ? "…" : ""}`,
        );
      }
      setPipeline((prev) =>
        prev
          ? {
              ...prev,
              phase: "awaiting-mockups",
              productId,
              createdHere,
              payload: json,
              payloadData: payload,
              appliedSignatures,
            }
          : prev,
      );
      try {
        await navigator.clipboard.writeText(json);
        toast.success(
          extensionReady
            ? "Mockups uploaded. Apply them in Printify with the extension, then continue."
            : "Mockup payload copied. Run the bookmarklet on Printify, then continue.",
        );
      } catch {
        toast.message("Mockup payload ready. Copy it from the dialog.");
      }
    } catch (error) {
      failRun(error);
    } finally {
      inFlight.current = false;
      setPublishing(false);
    }
  };

  /**
   * Ends the mockup step: the product is UPDATED in Printify, unpublished.
   *
   * This is the only thing a successful extension apply does. It never calls
   * the publish endpoint - publishing is `publishNow`, a separate click.
   */
  const markMockupsApplied = (detail?: string) => {
    if (!pipeline || pipeline.phase !== "awaiting-mockups") return;
    const { listingId, productId, createdHere } = pipeline;
    const linked = createdHere ? productId : productsByListing.get(listingId)?.productId;
    if (!productId || linked !== productId) {
      failRun(
        new Error(
          "This Printify product is no longer linked to this listing, so the update is not recorded.",
        ),
      );
      return;
    }
    patchStep("mockups", {
      status: "done",
      detail: detail ?? "Mockup selection applied in Printify.",
    });
    patchStep("publish", {
      status: "pending",
      detail:
        "Not run. The product is updated in Printify and still unpublished — publishing is the separate button below.",
    });
    setPipeline((prev) => (prev ? { ...prev, phase: "updated" } : prev));
    toast.success("Updated in Printify. The product is still unpublished.");

    /*
     * Remember exactly what was applied, so the next copy/price-only Send can
     * stop after the product PUT. Load the latest blob first: another tab may
     * have written a placement or a selection while the apply was running.
     */
    const records = pipeline.appliedSignatures;
    if (records && Object.keys(records).length > 0) {
      void (async () => {
        try {
          const latest = await loadSession();
          await saveSession(withAppliedMockups(latest, records));
        } catch {
          toast.warning(
            "The mockups were applied, but the local fast-update record could not be saved. The next Send will upload the images again.",
          );
        }
      })();
    }
  };

  /** Hands the payload to the extension: one click, in the background. */
  const applyWithExtension = () => {
    if (!pipeline || pipeline.phase !== "awaiting-mockups") return;
    if (!extensionReady || !pipeline.payloadData) {
      toast.error(
        "The Printify bridge extension is not installed yet. Use the bookmarklet below.",
      );
      return;
    }
    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `req-${Date.now()}`;
    applyRequestId.current = requestId;
    setExtensionApplying(true);
    setApplied(null);
    window.dispatchEvent(
      new CustomEvent("mockup-studio:apply-request", {
        detail: { payload: pipeline.payloadData, requestId },
      }),
    );
  };

  // The result listener is created once; keep its mark function current.
  React.useEffect(() => {
    markAppliedRef.current = markMockupsApplied;
  });

  /**
   * The ONLY place in this page that publishes.
   *
   * It is reachable only from the `updated` phase, i.e. after the mockup
   * selection has been applied, so the shop cannot receive Printify's
   * generated mockups. The product id is re-checked against this listing's own
   * link right before the request.
   */
  const publishNow = async () => {
    if (!pipeline || pipeline.phase !== "updated" || publishing || inFlight.current) return;
    const { listingId, productId, createdHere } = pipeline;
    const linked = createdHere
      ? productId
      : productsByListing.get(listingId)?.productId;

    inFlight.current = true;
    setPublishing(true);
    try {
      if (!productId || linked !== productId) {
        throw new Error(
          "This Printify product is no longer linked to this listing, so it will not be published.",
        );
      }
      patchStep("publish", { status: "running", detail: `Publishing ${productId}…` });

      const response = await authedFetch("/api/printify/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          productId,
          ...(selectedShop ? { shopId: selectedShop.id } : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as PublishResponse | null;
      if (!response.ok || !data?.published) {
        if (data?.code === 8254) {
          // The shop is not connected to Etsy. The endpoint names the shop and
          // where to connect it; carry that through to the dialog instead of
          // flattening it into one sentence.
          throw new PublishFailure(upstreamError(data, response.status), {
            code: 8254,
            shop:
              typeof data.shopId === "number"
                ? { id: data.shopId, title: data.shopTitle ?? "" }
                : undefined,
            connectUrl: data.connectUrl,
          });
        }
        throw new Error(upstreamError(data, response.status));
      }

      patchStep("publish", { status: "done", detail: `Published ${productId}.` });
      setPipeline((prev) => (prev ? { ...prev, phase: "done" } : prev));
      setPublished((prev) => ({ ...prev, [listingId]: { productId, at: Date.now() } }));
      try {
        await logActivity("listing.submit", `Published Printify product ${productId}`, {
          productId,
          listingId,
        });
      } catch {
        // The product is live; the activity log must not turn that into a
        // failure.
      }
    } catch (error) {
      failRun(error);
    } finally {
      inFlight.current = false;
      setPublishing(false);
    }
  };

  const copyPayload = async () => {
    if (!pipeline?.payload) return;
    try {
      await navigator.clipboard.writeText(pipeline.payload);
      toast.success("Payload copied.");
    } catch {
      toast.error("Could not copy. Select the text in the box instead.");
    }
  };

  const openPrintifyProduct = (productId: string) => {
    window.open(
      `https://printify.com/app/products/${productId}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  // --- render ---------------------------------------------------------------
  const listing = activeListing;
  const listingCopy = listing ? copyFor(listing) : null;
  const selected = listing ? selectionFor(listing) : [];
  const main = selected[0];
  const mainEntry = main ? currentEntry(main) : undefined;
  const linkedProduct = listing ? productsByListing.get(listing.listingId) : undefined;
  const publishedState = listing ? published[listing.listingId] : undefined;
  const blockers = listing ? blockersFor(listing) : [];
  const checks = listing ? checksFor(listing) : [];
  const cleared =
    listing ? session.listingImageCleared?.[listing.listingId] === true : false;

  // The dialog is about the run's own listing, not whichever tab happens to be
  // open. A live session write behind the modal must not be able to change the
  // summary of what the user is about to publish.
  const pipelineListing = pipeline
    ? listings.find((entry) => entry.listingId === pipeline.listingId)
    : undefined;
  const pipelineCopy = pipelineListing ? copyFor(pipelineListing) : null;
  const pipelineSelected = pipelineListing ? selectionFor(pipelineListing) : [];
  const pipelineCurrent = pipelineSelected.filter((image) => Boolean(currentEntry(image))).length;
  const pipelineLinked = pipelineListing
    ? productsByListing.get(pipelineListing.listingId)
    : undefined;
  /**
   * The confirm dialog tells the truth about what the click will do. The run
   * re-checks this before uploading, so a live edit while the dialog is open
   * cannot skip an image update.
   */
  const pipelineMockupsCurrent =
    !!pipelineListing &&
    !!pipelineLinked?.productId &&
    mockupsCurrentFor(pipelineListing, pipelineLinked.productId);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-8">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <Eye className="h-4 w-4 text-forest" /> Listing preview
              </h2>
              <p className="text-[12px] text-ink-muted">
                Each tab is one listing in the batch. The left is what a shopper sees; the right is
                what Printify receives. <strong>Send</strong> updates the product in Printify and
                stops unpublished; <strong>Publish</strong> is a separate, explicit click. A run
                stops at the first failure and nothing is retried behind your back.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" asChild>
                <Link href="/listing-images">Listing images →</Link>
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link href="/listing-details">Listing details →</Link>
              </Button>
            </div>
          </div>

          {listings.length > 0 && (
            <div className="flex items-end gap-2 border-b border-border-subtle">
              {/* The same numbered pills as the Mockups panel: oldest design
                  first, so tab 1 is the first uploaded. The number is all that
                  is visible; the design's name is the accessible name. */}
              <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
                {listings.map((entry, index) => {
                  const active = entry.listingId === listing?.listingId;
                  return (
                    <button
                      key={entry.listingId}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setActiveId(entry.listingId)}
                      title={entry.designName}
                      aria-label={entry.designName}
                      disabled={publishing}
                      className={`border-b-2 px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed ${
                        active
                          ? "border-forest text-forest"
                          : "border-transparent text-ink-muted hover:text-ink"
                      }`}
                    >
                      {index + 1}
                    </button>
                  );
                })}
              </div>
              <Badge variant="outline" className="mb-1.5 shrink-0">
                from Printify Studio
              </Badge>
            </div>
          )}

          {listing && (
            <p className="text-[12px] text-ink-subtle">
              {listing.partnerName
                ? `${listing.designName} + ${listing.partnerName} · one listing`
                : listing.designName}
              {" · "}the number is the listing's place in the batch, oldest design first
            </p>
          )}
        </CardContent>
      </Card>

      {listings.length === 0 ? (
        <div className="space-y-3">
          <EmptyState
            icon={<Eye />}
            title="No listings to preview"
            description="This page previews the designs ticked for the batch, so an empty tick list means there is nothing to preview — on purpose. Tick the designs you want on the Printify Studio's Designs tab, and pair the two halves of a one-product listing there."
          />
          <div className="flex justify-center">
            <Button asChild size="sm" variant="outline">
              <Link href="/printify-studio">Open the Printify Studio</Link>
            </Button>
          </div>
        </div>
      ) : (
        listing &&
        listingCopy && (
          <>
            <Card data-listing-id={listing.listingId}>
              <CardContent className="space-y-4 p-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  {/* --- the gallery ------------------------------------- */}
                  <div className="space-y-2">
                    {main ? (
                      mainEntry ? (
                        <div className="relative overflow-hidden rounded-md border border-border-subtle bg-surface-muted">
                          <AssetThumb
                            assetId={mainEntry.assetId}
                            className="aspect-square w-full"
                            alt={`${main.mockup.name} — the main image for ${listing.designName}`}
                          />
                          <span className="absolute left-2 top-2 rounded bg-forest px-1.5 py-0.5 text-[10px] font-medium text-white">
                            Main image
                          </span>
                          <span className="absolute bottom-2 left-2 max-w-[80%] truncate rounded bg-ink/70 px-1.5 py-0.5 text-[10px] text-white">
                            {main.mockup.name}
                          </span>
                        </div>
                      ) : (
                        // The FIRST selected image, unrendered. Shown as a
                        // hole, because a stand-in photo would be a listing
                        // image the product does not have.
                        <Link
                          href="/listing-images"
                          className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border-strong bg-surface-muted/40 p-4 text-center text-[12px] text-ink-muted transition-colors hover:bg-surface-muted"
                        >
                          <CircleDashed className="h-6 w-6 text-ink-subtle" />
                          <span className="font-medium text-ink">Not rendered yet</span>
                          <span>
                            The main image, {main.mockup.name}, has no current render.
                          </span>
                          <span className="text-forest underline">Render it on Listing images</span>
                        </Link>
                      )
                    ) : (
                      <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border-strong bg-surface-muted/40 p-4 text-center text-[12px] text-ink-muted">
                        <Images className="h-6 w-6 text-ink-subtle" />
                        <span className="font-medium text-ink">No images selected</span>
                        <span>
                          {cleared
                            ? "You cleared this listing's images, so it has none — a product needs at least one photo."
                            : (mockups ?? []).length === 0
                              ? "The mockup library is empty."
                              : "No mockups are included for this listing."}
                        </span>
                        <Link href="/listing-images" className="text-forest underline">
                          Choose the images
                        </Link>
                      </div>
                    )}

                    {selected.length > 1 && (
                      <div
                        className="flex gap-2 overflow-x-auto pb-1"
                        aria-label={`Images for ${listing.designName}`}
                      >
                        {selected.slice(1).map((image) => {
                          const entry = currentEntry(image);
                          return entry ? (
                            <div
                              key={image.mockup.id}
                              className="h-16 w-16 shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-muted"
                              title={image.mockup.name}
                            >
                              <AssetThumb
                                assetId={entry.assetId}
                                className="h-full w-full"
                                alt={image.mockup.name}
                              />
                            </div>
                          ) : (
                            <Link
                              key={image.mockup.id}
                              href="/listing-images"
                              title={`${image.mockup.name} is not rendered yet`}
                              className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded border border-dashed border-border-strong bg-surface-muted/40 text-center text-[9px] leading-tight text-ink-muted transition-colors hover:bg-surface-muted"
                            >
                              <CircleDashed className="h-3.5 w-3.5" />
                              not rendered
                            </Link>
                          );
                        })}
                      </div>
                    )}

                    <p className="text-[11px] text-ink-subtle">
                      {selected.length} image{selected.length === 1 ? "" : "s"} — the first is the
                      main image — chosen on{" "}
                      <Link href="/listing-images" className="text-forest underline">
                        Listing images
                      </Link>
                      {(() => {
                        const entries = selected
                          .map((image) => currentEntry(image))
                          .filter(Boolean);
                        const fromMockups = entries.filter(
                          (entry) => entry?.source === "mockups",
                        ).length;
                        return (
                          <>
                            {" — "}
                            <span className="font-medium text-ink-muted">
                              {fromMockups} from Mockups
                            </span>
                            {entries.length > fromMockups
                              ? `, ${entries.length - fromMockups} rendered on Listing images`
                              : ""}
                            {" — "}
                            <Link href="/listing-images" className="text-forest underline">
                              Fix images
                            </Link>
                          </>
                        );
                      })()}
                    </p>
                    {(() => {
                      const outdated = selected.filter(
                        (image) => image.entry && !image.fresh && !image.adopted,
                      );
                      if (outdated.length === 0) return null;
                      return (
                        <p className="text-[11px] text-warning">
                          {outdated.length} saved Mockups render
                          {outdated.length === 1 ? "" : "s"} may be out of date. {" "}
                          <Link href="/listing-images" className="text-forest underline">
                            Review them on Listing images
                          </Link>
                          .
                        </p>
                      );
                    })()}
                  </div>

                  {/* --- the copy ---------------------------------------- */}
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <h3 className="text-[18px] font-semibold leading-snug text-ink">
                        {listingCopy.title}
                      </h3>
                      {listingCopy.hasPrice ? (
                        <p className="text-[20px] font-semibold text-forest">
                          {formatCents(listingCopy.priceCents)}
                        </p>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="warning">No price set</Badge>
                          <Link href="/listing-details" className="text-[11px] text-forest underline">
                            Set a price on Listing details
                          </Link>
                        </div>
                      )}
                    </div>

                    {listingCopy.description.trim() ? (
                      <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-muted/50 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                        {listingCopy.description}
                      </div>
                    ) : (
                      <p className="rounded-md bg-surface-muted/50 px-3 py-2 text-[12px] text-ink-subtle">
                        No description yet.{" "}
                        <Link href="/listing-details" className="text-forest underline">
                          Write it on Listing details
                        </Link>
                        .
                      </p>
                    )}

                    <div className="flex flex-wrap gap-1.5">
                      {listingCopy.tags.length > 0 ? (
                        listingCopy.tags.map((tag) => (
                          <Badge key={tag} variant="muted">
                            {tag}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-[11px] text-ink-subtle">
                          No tags yet.{" "}
                          <Link href="/listing-details" className="text-forest underline">
                            Add tags
                          </Link>
                        </span>
                      )}
                    </div>

                    {listing.partnerName && (
                      <p className="rounded-md bg-sage-soft px-3 py-2 text-[11px] text-forest">
                        One listing, two designs: <strong>{listing.designName}</strong> prints the
                        plain and black-ink colours, and <strong>{listing.partnerName}</strong>{" "}
                        prints the white-ink colours. The images, title and price above belong to
                        the pair, not to either design alone.
                      </p>
                    )}

                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border-subtle pt-3 text-[12px]">
                      <dt className="text-ink-muted">Product type</dt>
                      <dd className="text-ink">{productName}</dd>
                      <dt className="text-ink-muted">Colours</dt>
                      <dd className="text-ink">
                        {colourCounts.plain} plain · {colourCounts.ink} ink
                        {colourCounts.black > 0 ? ` (${colourCounts.black} black ink)` : ""}
                      </dd>
                      <dt className="text-ink-muted">Variants</dt>
                      <dd className="text-ink">
                        {linkedProduct ? (
                          // The product's variants are frozen at creation; a
                          // live count here would describe the session, not
                          // the shop.
                          <>Fixed when the draft was created</>
                        ) : variantsLoading ? (
                          "Reading the product's variants…"
                        ) : variantsError ? (
                          <span className="text-warning">{variantsError}</span>
                        ) : (
                          `${variantPlan.ids.length} of ${MAX_VARIANTS} allowed`
                        )}
                      </dd>
                      <dt className="text-ink-muted">Category</dt>
                      <dd className="text-ink">{listingCopy.category || "—"}</dd>
                      <dt className="text-ink-muted">Quantity</dt>
                      <dd className="text-ink">{listingCopy.quantity}</dd>
                      <dt className="text-ink-muted">Printify product</dt>
                      <dd className="text-ink">
                        {linkedProduct ? (
                          <button
                            type="button"
                            onClick={() => openPrintifyProduct(linkedProduct.productId)}
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-forest hover:underline"
                          >
                            {linkedProduct.productId}
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        ) : (
                          <span className="text-ink-muted">Not created yet</span>
                        )}
                      </dd>
                      <dt className="text-ink-muted">Target shop</dt>
                      <dd className="text-ink">
                        {targetShop ? (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            {targetShop.title || "Untitled shop"}
                            <span className="font-mono text-[11px] text-ink-muted">
                              #{targetShop.id}
                            </span>
                            {targetShop.connected ? (
                              <Badge variant="muted">
                                {targetShop.salesChannel || "connected"}
                              </Badge>
                            ) : (
                              <Badge variant="warning">Not connected</Badge>
                            )}
                          </span>
                        ) : shops === null ? (
                          <span className="text-ink-muted">Reading the shop list…</span>
                        ) : savedShopId != null ? (
                          <span className="text-warning">
                            Saved shop #{savedShopId} is missing from this account
                          </span>
                        ) : (
                          <span className="text-warning">No shop selected</span>
                        )}
                        {" · "}
                        <Link href="/settings" className="text-forest underline">
                          Change
                        </Link>
                      </dd>
                    </dl>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-2 p-4">
                <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                  <ClipboardCheck className="h-4 w-4 text-forest" /> What Printify gets
                </h2>
                <p className="text-[12px] text-ink-muted">
                  Every line is read from this browser right now — nothing here is an estimate. A
                  cross means the shop would get less than a complete listing.
                </p>
                <ul className="space-y-1.5">
                  {checks.map((check) => (
                    <li
                      key={check.key}
                      data-check={check.key}
                      data-ok={check.ok ? "true" : "false"}
                      className="flex flex-wrap items-start gap-2 rounded-md border border-border-subtle px-3 py-2"
                    >
                      {check.ok ? (
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                      )}
                      <p className="min-w-0 flex-1 text-[12px] text-ink">
                        <span className="font-medium">{check.label}</span>
                        <span className="text-ink-muted"> — {check.detail}</span>
                      </p>
                      {!check.ok && (
                        <Button asChild size="sm" variant="outline">
                          <Link href={check.href}>{check.action}</Link>
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                      <Rocket className="h-4 w-4 text-forest" /> Send to Printify
                    </h2>
                    <p className="text-[12px] text-ink-muted">
                      Create the draft if this listing has none, upload its images, and apply the
                      mockup selection. The run stops with the product updated in Printify — it
                      never publishes. Publishing is a separate, explicit click.
                    </p>
                    <p className="mt-1 text-[11px] text-ink-muted">
                      {extensionReady
                        ? "Printify bridge extension detected — the mockup step is one click."
                        : "Printify bridge extension not detected — the dialog offers the bookmarklet instead."}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={() => openConfirm("send")}
                      disabled={publishing || blockers.length > 0 || Boolean(publishedState)}
                    >
                      {publishing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      Send to Printify
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => openConfirm("publish")}
                      disabled={publishing || blockers.length > 0 || Boolean(publishedState)}
                    >
                      <Rocket className="h-4 w-4" /> Publish to Printify
                    </Button>
                  </div>
                </div>

                {blockers.length > 0 && (
                  <div className="space-y-1 rounded-md bg-surface-muted px-3 py-2">
                    <p className="text-[12px] font-medium text-ink">
                      Both buttons stay off until this is true:
                    </p>
                    <ul className="space-y-1">
                      {blockers.map((blocker) => (
                        <li
                          key={blocker}
                          className="flex items-start gap-1.5 text-[11px] text-ink-muted"
                        >
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                          <span>{blocker}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {publishedState && (
                  <div className="space-y-1 rounded-md bg-sage-soft px-3 py-2 text-[12px] text-forest">
                    <p className="flex items-center gap-1.5 font-medium">
                      <Check className="h-3.5 w-3.5" /> Published — live on your shop
                    </p>
                    <p className="flex flex-wrap items-center gap-1.5">
                      Product <span className="font-mono text-[11px]">{publishedState.productId}</span>
                      <button
                        type="button"
                        onClick={() => openPrintifyProduct(publishedState.productId)}
                        className="inline-flex items-center gap-1 underline"
                      >
                        Open it on Printify <ExternalLink className="h-3 w-3" />
                      </button>
                    </p>
                    <p className="text-[11px]">
                      The button above stays off now: publishing an already-published product errors
                      upstream. This page updates unpublished drafts; edit the live product on
                      Printify.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )
      )}

      {/* --- the one dialog: confirm, run, apply, then an explicit publish --- */}
      <Dialog open={pipeline !== null} onOpenChange={(open) => (open ? null : closePipeline())}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="h-4 w-4 text-forest" />
              {pipeline?.phase === "done"
                ? "Published"
                : pipeline?.phase === "updated"
                  ? "Updated in Printify"
                  : pipeline?.intent === "send"
                    ? `Send ${pipeline?.designName ?? "this listing"} to Printify`
                    : `Publish ${pipeline?.designName ?? "this listing"}`}
            </DialogTitle>
            <DialogDescription>
              {pipeline?.phase === "confirm"
                ? pipeline?.intent === "send"
                  ? "Create or update the draft, upload the images, apply the mockups. The run stops there with the product updated in Printify and unpublished — publishing is never automatic."
                  : "Four steps, in order. The first three send the listing to Printify; the fourth publishes only when you press the separate publish button."
                : pipeline?.phase === "awaiting-mockups"
                  ? "The product exists and its images are uploaded. Printify's selection step only works in its own web session, so the run waits for you — the extension does it in one click, the bookmarklet is the fallback."
                  : pipeline?.phase === "updated"
                    ? "The product is updated in Printify and still unpublished. Nothing was published; that is the separate button below."
                    : pipeline?.phase === "done"
                      ? "The product is live. Nothing else ran after the publish call."
                      : pipeline?.phase === "failed"
                        ? "The run stopped at the step below. Nothing was retried."
                        : "Running the steps in order…"}
            </DialogDescription>
          </DialogHeader>

          {pipeline && (
            <div className="space-y-3">
              {pipeline.phase === "confirm" && (
                <div className="space-y-1 rounded-md bg-surface-muted px-3 py-2 text-[12px]">
                  <p className="font-medium text-ink">{pipelineCopy?.title}</p>
                  <p className="text-ink-muted">
                    {pipelineCopy?.hasPrice
                      ? `${formatCents(pipelineCopy.priceCents)} on every variant`
                      : "No price set"}{" "}
                    · {pipelineCurrent} image{pipelineCurrent === 1 ? "" : "s"} ·{" "}
                    {pipelineCopy?.tags.length ?? 0} tag
                    {(pipelineCopy?.tags.length ?? 0) === 1 ? "" : "s"}
                  </p>
                  <p className="text-ink-muted">
                    Target shop:{" "}
                    {targetShop
                      ? `${targetShop.title || "Untitled shop"} (#${targetShop.id})`
                      : "not resolved"}
                  </p>
                  {pipelineMockupsCurrent && (
                    <p className="rounded-md bg-sage-soft px-2 py-1 text-[11px] text-forest">
                      These exact mockups were already applied to this product. Send will
                      update only the title, description, tags and price — no image is
                      re-rendered, re-uploaded or re-applied.
                    </p>
                  )}
                  {!pipelineLinked &&
                    pipelineListing &&
                    Math.abs(placementFor(session, pipelineListing.designId).scale - 1) > 0.001 && (
                      // The shared creation path sends the artwork centred at
                      // its default scale, not this design's custom placement.
                      // Say so before the click, not after the shop shows it.
                      <p className="text-[11px] text-warning">
                        This design has a custom placement. Creating the draft uses the shared
                        creation path, which centres the artwork at 100% on the print area — check
                        the product in Printify after the run.
                      </p>
                    )}
                </div>
              )}

              <ol className="space-y-2">
                {pipeline.steps.map((step, index) => (
                  <li key={step.key} data-step={step.key} data-status={step.status} className="flex gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[11px] font-semibold text-ink-muted">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                        {step.title}
                        <StepIcon status={step.status} />
                      </p>
                      <p className="text-[11px] leading-relaxed text-ink-muted">{step.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>

              {pipeline.phase === "confirm" && (
                <p className="rounded-md bg-warning-soft px-3 py-2 text-[11px] text-warning">
                  {pipelineMockupsCurrent
                    ? "The images are unchanged, so this run only updates the product copy and price. It does NOT publish: the product stays an unpublished draft in Printify."
                    : pipeline.intent === "send"
                      ? "This run creates the draft, uploads the images and applies the mockups. It does NOT publish: the product stays an unpublished draft in Printify."
                      : "The product is created as an unpublished draft first. Publishing is the last, separate click, so a failure before it leaves nothing live."}
                </p>
              )}

              {pipeline.phase === "awaiting-mockups" && (
                <div className="space-y-3 rounded-md border border-border-subtle p-3">
                  {extensionReady && (
                    <div className="space-y-1.5 rounded-md border border-forest/40 bg-forest-soft/20 px-3 py-2">
                      <p className="text-[12px] font-medium text-ink">
                        {applied ? "Mockups applied" : "Apply in Printify — one click"}
                      </p>
                      <p className="text-[11px] text-ink-muted">
                        {applied
                          ? `Applied ${applied.done} of ${applied.total} product${
                              applied.total === 1 ? "" : "s"
                            }. The extension ran inside your own signed-in Printify session and closed the tab. It does not publish.`
                          : "The Printify bridge extension opens the product in a background tab, selects these mockups with your own sign-in, and closes it. It does not publish."}
                      </p>
                      {applied && applied.failures.length > 0 && (
                        <div className="max-h-24 space-y-1 overflow-y-auto rounded-md bg-warning-soft px-2 py-1 text-[11px] text-warning">
                          {applied.failures.map((line) => (
                            <p key={line}>{line}</p>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={applyWithExtension}
                          disabled={extensionApplying || !pipeline.payloadData}
                        >
                          {extensionApplying ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" />
                          )}
                          {extensionApplying
                            ? "Applying in Printify"
                            : applied
                              ? "Apply again"
                              : "Apply in Printify"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            pipeline.productId && openPrintifyProduct(pipeline.productId)
                          }
                          disabled={!pipeline.productId}
                        >
                          <ExternalLink className="h-3.5 w-3.5" /> Open the product to check
                        </Button>
                      </div>
                    </div>
                  )}

                  {extensionOld && (
                    <p className="rounded-md bg-warning-soft px-2 py-1 text-[11px] text-warning">
                      {extensionReloadMessage()}
                    </p>
                  )}
                  <div className="space-y-1.5">
                    <p className="text-[12px] font-medium text-ink">
                      {extensionReady ? "Or use the bookmarklet" : "1. Copy the payload"}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      It is copied automatically when the browser allows it; otherwise use the
                      button. The bookmarklet reads this exact text.
                    </p>
                    <Textarea
                      readOnly
                      value={pipeline.payload ?? ""}
                      className="h-20 font-mono text-[10px]"
                      onFocus={(event) => event.currentTarget.select()}
                      aria-label="Mockup payload"
                    />
                    <Button size="sm" variant="outline" onClick={() => void copyPayload()}>
                      Copy payload
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[12px] font-medium text-ink">
                      {extensionReady
                        ? "2. Run it on the product"
                        : "2. Apply it in your own Printify session"}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      Save the bookmarklet once, open{" "}
                      {pipeline.productId ? "this product" : "the product"} on printify.com, then
                      click it. It reads the payload and uses your signed-in session — no token
                      leaves printify.com.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          window.open(
                            "/printify-bookmarklet",
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                      >
                        Install guide & copy bookmarklet
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          pipeline.productId && openPrintifyProduct(pipeline.productId)
                        }
                        disabled={!pipeline.productId}
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Open Printify
                      </Button>
                    </div>
                  </div>
                  <p className="rounded-md bg-warning-soft px-3 py-2 text-[11px] text-warning">
                    Continue only once the selection is applied. Continuing records the update in
                    Printify — it does not publish. Publishing is the separate button after this
                    step.
                  </p>
                </div>
              )}

              {pipeline.phase === "updated" && (
                <div className="space-y-1.5 rounded-md bg-sage-soft px-3 py-2 text-[12px] text-forest">
                  <p className="flex items-center gap-1.5 font-medium">
                    <Check className="h-3.5 w-3.5" /> Updated in Printify — still unpublished
                  </p>
                  <p className="font-mono text-[11px]">{pipeline.productId}</p>
                  <p className="text-[11px]">
                    {pipeline.fastPath
                      ? "Only the title, description, tags and price changed. The mockups were already current, so nothing was re-uploaded or re-applied. Nothing was published."
                      : "The draft now has this listing's images and mockup selection. Nothing was published, so it is not on your shop yet."}{" "}
                    Check it on Printify, then press Publish now when you want it live.
                  </p>
                </div>
              )}

              {pipeline.phase === "done" && (
                <div className="space-y-1.5 rounded-md bg-sage-soft px-3 py-2 text-[12px] text-forest">
                  <p className="flex items-center gap-1.5 font-medium">
                    <Check className="h-3.5 w-3.5" /> Published — live on your shop
                  </p>
                  <p className="font-mono text-[11px]">{pipeline.productId}</p>
                  <p className="text-[11px]">
                    Changing the copy here afterwards does not update the live product; edit it on
                    Printify instead.
                  </p>
                </div>
              )}

              {pipeline.phase === "failed" && (
                <div role="alert" className="space-y-1.5 rounded-md bg-danger-soft px-3 py-2">
                  <p className="text-[12px] font-medium text-danger">
                    The run stopped. Nothing was retried and nothing after this step ran.
                  </p>
                  <p className="break-words font-mono text-[11px] text-danger">{pipeline.error}</p>
                  {pipeline.errorCode === 8254 && (
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-danger">
                      {pipeline.errorShop && (
                        <span>
                          Shop {pipeline.errorShop.title ? `"${pipeline.errorShop.title}" ` : ""}
                          (#{pipeline.errorShop.id}) has no sales channel.
                        </span>
                      )}
                      {pipeline.errorConnectUrl && (
                        <a
                          href={pipeline.errorConnectUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium underline"
                        >
                          Connect it in Printify <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      <Link href="/settings" className="inline-flex items-center gap-1 font-medium underline">
                        Choose a connected shop in Settings
                      </Link>
                    </p>
                  )}
                </div>
              )}

              {pipeline.phase === "failed" && (
                <p className="text-[11px] text-ink-muted">
                  A product created before the failure is an unpublished draft. Fix the cause, then
                  open this dialog again: the run restarts from step 1, skips a product that is
                  already linked to this listing, and uploads the images again.
                </p>
              )}

              <DialogFooter>
                {pipeline.phase === "confirm" ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={closePipeline}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => void startRun()} disabled={publishing}>
                      <Sparkles className="h-3.5 w-3.5" />{" "}
                      {pipelineMockupsCurrent
                        ? "Update details only"
                        : pipelineLinked
                          ? "Update & upload"
                          : "Create & upload"}
                    </Button>
                  </>
                ) : pipeline.phase === "awaiting-mockups" ? (
                  <Button
                    size="sm"
                    onClick={() => markMockupsApplied()}
                    disabled={publishing || extensionApplying}
                  >
                    {extensionApplying ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    The mockups are applied — continue
                  </Button>
                ) : pipeline.phase === "updated" ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={closePipeline} disabled={publishing}>
                      Close
                    </Button>
                    <Button
                      size="sm"
                      variant={pipeline.intent === "publish" ? "default" : "outline"}
                      onClick={() => void publishNow()}
                      disabled={publishing}
                    >
                      {publishing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Rocket className="h-3.5 w-3.5" />
                      )}
                      Publish now
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={closePipeline} disabled={publishing}>
                    Close
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
