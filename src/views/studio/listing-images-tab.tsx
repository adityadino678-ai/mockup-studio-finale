"use client";

// ---------------------------------------------------------------------------
// Listing images.
//
// One card per listing, one tile per mockup. The ticks are the listing's
// images, in the order they were clicked: the first one is the main image.
// "Save & render" renders only what changed, reuses every fresh render, then
// writes the local listing drafts the Export Center reads.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { zip, type Zippable } from "fflate";
import { db, getSetting } from "@/lib/db/schema";
import { getAssetBlob, logActivity } from "@/lib/db/repo";
import { authedFetch } from "@/lib/client/integrations";
import { mockupImageForUpload } from "@/lib/client/mockup-upload";
import { AssetThumb } from "@/components/asset-thumb";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Progress } from "@/components/ui/primitives";
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
  listingMockupIds,
  listingRenderFor,
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
import {
  bridgePayloadJson,
  buildBridgePayload,
  countBridgeImages,
  type PrintifyBridgeProduct,
  type PrintifyMockupUpload,
} from "@/lib/printify/mockup-bridge";
import type { StudioCatalogState } from "@/views/printify-studio-page";
import type {
  Design,
  Mockup,
  Placement,
  StudioListingRender,
  StudioProductResult,
  StudioSession,
} from "@/types/domain";
import {
  Check,
  Download,
  ExternalLink,
  Images,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";

interface ListingImagesTabProps {
  session: StudioSession;
  update: (patch: Partial<StudioSession>) => void;
  catalog: StudioCatalogState;
  onGoToDesigns: () => void;
  onGoToPanel: () => void;
  onGoToDetails: () => void;
}

interface SelectedImage {
  mockup: Mockup;
  entry: StudioListingRender | undefined;
  fresh: boolean;
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

export function ListingImagesTab({
  session,
  update,
  catalog,
  onGoToDesigns,
  onGoToPanel,
  onGoToDetails,
}: ListingImagesTabProps) {
  const designs = useLiveQuery(() => db.designs.toArray(), []);
  const mockups = useLiveQuery(() => db.mockups.orderBy("createdAt").toArray(), []);
  const placements = useLiveQuery(() => db.placements.toArray(), []);
  const results = useLiveQuery(async () => {
    const stored = await getSetting<StudioProductResult[]>(RESULTS_KEY, []);
    return Array.isArray(stored) ? stored : [];
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
  const [bridgeSummary, setBridgeSummary] = React.useState<{
    products: number;
    images: number;
    failures: string[];
    skipped: string[];
    firstProductId?: string;
  } | null>(null);

  // The render loop is long. If the user edits copy/selection on another tab
  // while it runs, the final save must use that newer state, not the snapshot
  // captured at click time.
  const sessionRef = React.useRef(session);
  React.useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const listings = React.useMemo(
    () => buildStudioListings((designs ?? []) as Design[], session),
    [designs, session],
  );
  const rows = React.useMemo(() => groupStudioListings(listings), [listings]);
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

  const selectionFor = React.useCallback(
    (listing: StudioListing): SelectedImage[] => {
      return listingMockupIds(session, listing.listingId)
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
          return {
            mockup,
            entry,
            fresh: isListingRenderFresh(entry, fingerprint),
          };
        });
    },
    [session, mockupsById, placementsByKey],
  );

  const totalSelected = React.useMemo(
    () => listings.reduce((sum, listing) => sum + selectionFor(listing).length, 0),
    [listings, selectionFor],
  );
  const freshSelected = React.useMemo(
    () =>
      listings.reduce(
        (sum, listing) => sum + selectionFor(listing).filter((image) => image.fresh).length,
        0,
      ),
    [listings, selectionFor],
  );
  const canSend = React.useMemo(
    () =>
      listings.some((listing) => {
        const result = resultsByListing.get(listing.listingId);
        return Boolean(
          result?.remoteProductId && selectionFor(listing).some((image) => image.fresh),
        );
      }),
    [listings, resultsByListing, selectionFor],
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
      const current = listingMockupIds(session, listing.listingId).filter((id) =>
        mockupsById.has(id),
      );
      const next = current.includes(mockupId)
        ? current.filter((id) => id !== mockupId)
        : [...current, mockupId];
      update(selectionPatch(listing.listingId, next, next.length === 0));
    },
    [session, update, selectionPatch, mockupsById, rendering, sending],
  );

  const selectAll = React.useCallback(
    (listing: StudioListing) => {
      if (rendering || sending) return;
      const current = listingMockupIds(session, listing.listingId).filter((id) =>
        mockupsById.has(id),
      );
      const all = (mockups ?? []).map((mockup) => mockup.id);
      const next = [...current, ...all.filter((id) => !current.includes(id))];
      update(selectionPatch(listing.listingId, next, false));
    },
    [session, update, selectionPatch, mockups, mockupsById, rendering, sending],
  );

  const clearListing = React.useCallback(
    (listing: StudioListing) => {
      if (rendering || sending) return;
      update(selectionPatch(listing.listingId, [], true));
    },
    [update, selectionPatch, rendering, sending],
  );

  const renderSelected = async () => {
    if (rendering || sending) return;
    const targets = listings.flatMap((listing) =>
      selectionFor(listing).map((image) => ({ listing, image })),
    );
    if (targets.length === 0) {
      toast.error("Tick at least one mockup first.");
      return;
    }

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
        const existing = nextRenders[key];
        if (image.fresh && existing && (await db.assets.get(existing.assetId))) {
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
            placement: placementFor(session, listing.designId),
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

      const latest = sessionRef.current;
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

      const nextSession: StudioSession = {
        ...latest,
        listingRenders: mergedRenders,
      };
      update({ listingRenders: mergedRenders });

      // Rebuild listings from the live session/designs: the user may have
      // changed the scope or the copy while the render loop was running.
      const latestDesigns = (await db.designs.toArray()) as Design[];
      const latestListings = buildStudioListings(latestDesigns, latest);
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
      const images = selected.filter((image) => image.fresh && image.entry);
      unrendered += selected.length - images.length;
      if (images.length === 0) continue;
      const folder = `MockupStudio_Listing_Images/${safeName(
        listing.designName,
      )}-${listing.listingId.slice(0, 6)}`;
      for (const [index, image] of images.entries()) {
        const blob = image.entry ? await getAssetBlob(image.entry.assetId) : null;
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
    setSendProgress({ done: 0, total: targets.length, label: "Preparing images…" });
    const prepared: PrintifyBridgeProduct[] = [];
    const failures: string[] = [];
    const skipped: string[] = [];

    try {
      for (const [index, listing] of targets.entries()) {
        const result = resultsByListing.get(listing.listingId);
        const selected = selectionFor(listing);
        const images = selected.filter((image) => image.fresh && image.entry);
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
              const blob = await getAssetBlob(image.entry!.assetId);
              if (!blob) {
                throw new Error(`${image.mockup.name} has no stored render`);
              }
              const converted = await mockupImageForUpload(
                blob,
                `${listing.designName}-${image.mockup.name}`,
              );
              payloadImages.push(converted);
            }
            const response = await authedFetch("/api/printify/mockups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                confirm: true,
                shopId,
                productId: result.remoteProductId,
                expectedTitle: result.title,
                images: payloadImages,
              }),
            });
            const data = (await response.json()) as UploadResponse;
            if (!response.ok) {
              throw new Error(data.error ?? `HTTP ${response.status}`);
            }
            if (!Array.isArray(data.uploads) || data.uploads.length !== chunk.length) {
              throw new Error("Printify did not return one custom mockup per image");
            }
            uploads.push(...data.uploads);
            shopId = data.shopId ?? shopId;
            productTitle = data.title ?? productTitle;
          }
          if (shopId == null || !Number.isFinite(shopId) || shopId <= 0) {
            throw new Error("Printify did not return the shop for this product");
          }
          prepared.push({
            shopId,
            productId: result.remoteProductId,
            productTitle,
            uploads,
          });
        } catch (error) {
          failures.push(
            `${listing.designName}: ${
              error instanceof Error ? error.message : "upload failed"
            }`,
          );
        }
        setSendProgress({
          done: index + 1,
          total: targets.length,
          label: "products prepared…",
        });
      }

      if (prepared.length === 0) {
        toast.error(
          [
            "Nothing was prepared for Printify.",
            ...failures.slice(0, 2),
            ...skipped.slice(0, 2),
          ].join(" "),
        );
        return;
      }

      const payload = buildBridgePayload(prepared);
      const json = bridgePayloadJson(payload);
      setBridgePayload(json);
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

  const renderRow = (row: "plain" | "ink") => {
    const rowListings = rows[row];
    if (rowListings.length === 0) return null;
    return (
      <section key={row} className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
              <Sparkles className="h-4 w-4 text-forest" />
              {ROW_LABELS[row]}
              <Badge variant="muted">{rowListings.length}</Badge>
            </h2>
            <p className="text-[12px] text-ink-muted">{ROW_HINTS[row]}</p>
          </div>
        </div>

        <div className="space-y-4">
          {rowListings.map((listing) => {
            const selected = selectionFor(listing);
            const rawSelected = listingMockupIds(session, listing.listingId).length;
            const fresh = selected.filter((image) => image.fresh).length;
            const result = resultsByListing.get(listing.listingId);
            return (
              <Card key={listing.listingId} data-listing-id={listing.listingId}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-[14px] font-semibold text-ink">
                        {listing.designName}
                      </h3>
                      <p className="text-[11px] text-ink-muted">
                        {listing.partnerName
                          ? `One listing with ${listing.partnerName} · first tick is the main image`
                          : "First tick is the main image"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={selected.length > 0 ? "forest" : "muted"}>
                        {selected.length} selected
                      </Badge>
                      {selected.length > 0 && (
                        <Badge variant={fresh === selected.length ? "default" : "muted"}>
                          {fresh === selected.length ? "rendered" : `${fresh}/${selected.length} rendered`}
                        </Badge>
                      )}
                      {result?.remoteProductId ? (
                        <a
                          href={`https://printify.com/app/products/${result.remoteProductId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-forest hover:bg-surface-muted"
                        >
                          <ExternalLink className="h-3 w-3" /> Product
                        </a>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={onGoToPanel}>
                          Create product
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => selectAll(listing)}
                      disabled={rendering || sending || (mockups ?? []).length === 0}
                    >
                      <Check className="h-3.5 w-3.5" /> Select all
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => clearListing(listing)}
                      disabled={rendering || sending || rawSelected === 0}
                    >
                      Clear
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void downloadListings([listing], safeName(listing.designName))}
                      disabled={rendering || sending || fresh === 0}
                    >
                      <Download className="h-3.5 w-3.5" /> Download
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void sendToPrintify([listing])}
                      disabled={rendering || sending || fresh === 0 || !result?.remoteProductId}
                    >
                      <Send className="h-3.5 w-3.5" /> Send
                    </Button>
                  </div>

                  {(mockups ?? []).length === 0 ? (
                    <p className="rounded-md bg-surface-muted px-3 py-2 text-[12px] text-ink-muted">
                      No mockups in the library yet. Add some on the{" "}
                      <a className="text-forest underline" href="/mockups">
                        Mockups page
                      </a>
                      , then come back.
                    </p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {(mockups ?? []).map((mockup) => {
                        const image = selected.find((entry) => entry.mockup.id === mockup.id);
                        const order = image
                          ? selected.findIndex((entry) => entry.mockup.id === mockup.id) + 1
                          : 0;
                        return (
                          <div
                            key={mockup.id}
                            className={`relative overflow-hidden rounded-md border transition-colors ${
                              image
                                ? "border-forest bg-forest-soft/20"
                                : "border-border-subtle bg-surface"
                            }`}
                          >
                            <button
                              type="button"
                              className="block w-full text-left disabled:cursor-not-allowed"
                              onClick={() => toggleMockup(listing, mockup.id)}
                              disabled={rendering || sending}
                              aria-pressed={Boolean(image)}
                              aria-label={`${image ? "Remove" : "Use"} ${mockup.name} for ${listing.designName}`}
                            >
                              <div className="relative aspect-square overflow-hidden bg-surface-muted">
                                <AssetThumb
                                  assetId={image?.entry?.assetId ?? mockup.assetId}
                                  className="h-full w-full"
                                  alt={mockup.name}
                                />
                                {order > 0 && (
                                  <span className="absolute left-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-forest px-1.5 text-[11px] font-semibold text-white shadow-subtle">
                                    {order}
                                  </span>
                                )}
                                {image && (
                                  <span
                                    className={`absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                      image.entry && image.fresh
                                        ? "bg-forest text-white"
                                        : "bg-warning text-white"
                                    }`}
                                  >
                                    {!image.entry
                                      ? "Not rendered"
                                      : image.fresh
                                        ? "Rendered"
                                        : "Needs render"}
                                  </span>
                                )}
                              </div>
                              <div className="space-y-0.5 p-2">
                                <p className="truncate text-[12px] font-medium text-ink" title={mockup.name}>
                                  {mockup.name}
                                </p>
                                <p className="text-[10px] text-ink-subtle">
                                  {mockup.printArea ? "Print area mapped" : "No print area"}
                                </p>
                              </div>
                            </button>
                            <div className="absolute right-2 top-2">
                              <Checkbox
                                checked={Boolean(image)}
                                onCheckedChange={() => toggleMockup(listing, mockup.id)}
                                disabled={rendering || sending}
                                aria-label={`Select ${mockup.name} for ${listing.designName}`}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <Images className="h-4 w-4 text-forest" /> Listing images
              </h2>
              <p className="text-[12px] text-ink-muted">
                Tick every mockup a listing should use. The numbers are the click order; the
                first image is the main image. Save &amp; render writes the local listing drafts
                and only re-renders what changed.
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
                Save &amp; render {totalSelected > 0 ? `(${totalSelected})` : ""}
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
              <p className="text-[11px] text-ink-muted" aria-live="polite">
                {rendering
                  ? `${progress.done}/${progress.total} · ${progress.label}`
                  : `${sendProgress.done}/${sendProgress.total} · ${sendProgress.label}`}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-muted/60 px-3 py-2">
            <p className="text-[12px] text-ink-muted">
              <strong>{totalSelected}</strong> image{totalSelected === 1 ? "" : "s"} selected across{" "}
              <strong>{listings.length}</strong> listing{listings.length === 1 ? "" : "s"} ·{" "}
              {freshSelected} current render{freshSelected === 1 ? "" : "s"}
            </p>
            <Button size="sm" variant="ghost" onClick={onGoToDetails}>
              Edit titles, tags &amp; prices →
            </Button>
          </div>
        </CardContent>
      </Card>

      {listings.length === 0 ? (
        <EmptyState
          icon={<Images />}
          title="No listings yet"
          description="Tick the designs this batch should create on the Designs tab. Each design becomes one listing; a pair becomes one listing."
          actions={[{ label: "Go to Designs", onClick: onGoToDesigns }]}
        />
      ) : (
        <>
          {renderRow("plain")}
          {renderRow("ink")}
        </>
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
                  }. Printify only exposes the selection step to its own web session, so the last step runs in your browser.`
                : "The payload is ready."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {(bridgeSummary?.failures.length ?? 0) + (bridgeSummary?.skipped.length ?? 0) > 0 && (
              <div className="max-h-24 space-y-1 overflow-y-auto rounded-md bg-warning-soft px-3 py-2 text-[11px] text-warning">
                {bridgeSummary?.failures.map((line) => <p key={line}>{line}</p>)}
                {bridgeSummary?.skipped.map((line) => <p key={line}>{line}</p>)}
              </div>
            )}

            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-ink">1. Copy the payload</p>
              <Textarea
                readOnly
                value={bridgePayload}
                className="h-24 font-mono text-[10px]"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button size="sm" variant="outline" onClick={() => void copyPayload()}>
                Copy payload
              </Button>
            </div>

            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-ink">2. Run the bookmarklet on Printify</p>
              <p className="text-[11px] text-ink-muted">
                Save the bookmarklet once, open the product in Printify, then click it. It reads
                this payload from the clipboard and uses your own signed-in session. No token
                leaves printify.com.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    window.open("/printify-bookmarklet", "_blank", "noopener,noreferrer")
                  }
                >
                  Install guide &amp; copy bookmarklet
                </Button>
                <Button size="sm" onClick={openPrintify}>
                  <ExternalLink className="h-3.5 w-3.5" /> Open Printify
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setBridgeOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
