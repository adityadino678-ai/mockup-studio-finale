"use client";

// ---------------------------------------------------------------------------
// Listing details.
//
// One listing per design (or per pair), so the copy and price fields are bulk:
// one title template, one description, one tag list and one price rule applied
// to every listing. A custom price is still per listing. Save writes the
// session and every local listing draft together.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db, getSetting } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { FieldLabel, Input, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/primitives";
import {
  buildStudioListings,
  catalogProductName,
  groupStudioListings,
} from "@/lib/printify/listing-plan";
import {
  listingMockupIds,
  listingRenderFor,
  MAX_TAGS,
  parseTags,
  placementFor,
  renderTemplate,
  renderTitle,
  RESULTS_KEY,
  ROW_LABELS,
} from "@/lib/printify/studio-session";
import { saveStudioListingDrafts } from "@/lib/printify/listing-drafts";
import {
  isListingRenderFresh,
  listingImageFingerprint,
} from "@/lib/printify/listing-render";
import type { StudioCatalogState } from "@/views/printify-studio-page";
import type {
  Design,
  Mockup,
  Placement,
  StudioProductResult,
  StudioSession,
} from "@/types/domain";
import { ArrowLeft, Images, Loader2, Save, Tags } from "lucide-react";

interface ListingDetailsTabProps {
  session: StudioSession;
  update: (patch: Partial<StudioSession>) => void;
  catalog: StudioCatalogState;
  /** True once the stored session has loaded, so the form hydrates once. */
  loaded: boolean;
  onGoToDesigns: () => void;
  onGoToImages: () => void;
  onGoToPanel: () => void;
}

interface DetailsForm {
  titleTemplate: string;
  descriptionTemplate: string;
  tagsText: string;
  priceMode: "fixed" | "custom";
  fixedPrice: string;
  customPrices: Record<string, string>;
  category: string;
  quantity: string;
}

function centsToDollars(cents: number | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents <= 0) return "";
  return (cents / 100).toFixed(2);
}

function dollarsToCents(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Accept "12,50" as a decimal, but reject "12.99.00", "1e3" and other
  // ambiguous input instead of silently turning it into a different price.
  const normalized = trimmed
    .replace(/\s+/g, "")
    .replace(/^\$/, "")
    .replace(",", ".");
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 100);
}

function formFromSession(session: StudioSession): DetailsForm {
  const prices: Record<string, string> = {};
  for (const [id, cents] of Object.entries(session.listingPrices ?? {})) {
    prices[id] = centsToDollars(cents);
  }
  return {
    titleTemplate: session.titleTemplate ?? "",
    descriptionTemplate: session.descriptionTemplate ?? "",
    tagsText: (session.tags ?? []).join(", "),
    priceMode: session.priceMode === "custom" ? "custom" : "fixed",
    fixedPrice: centsToDollars(session.priceCents),
    customPrices: prices,
    category: session.category ?? "",
    quantity: String(session.quantity && session.quantity > 0 ? session.quantity : 1),
  };
}

export function ListingDetailsTab({
  session,
  update,
  catalog,
  loaded,
  onGoToDesigns,
  onGoToImages,
  onGoToPanel,
}: ListingDetailsTabProps) {
  const designs = useLiveQuery(() => db.designs.toArray(), []);
  const mockups = useLiveQuery(() => db.mockups.toArray(), []);
  const placements = useLiveQuery(() => db.placements.toArray(), []);
  const results = useLiveQuery(async () => {
    const stored = await getSetting<StudioProductResult[]>(RESULTS_KEY, []);
    return Array.isArray(stored) ? stored : [];
  }, []);

  const [form, setForm] = React.useState<DetailsForm>(() => formFromSession(session));
  const [saving, setSaving] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const hydrated = React.useRef(false);

  React.useEffect(() => {
    if (!loaded || hydrated.current) return;
    hydrated.current = true;
    setForm(formFromSession(session));
  }, [loaded, session]);

  const productName = catalogProductName(catalog.blueprints, session.blueprintId);
  const listings = React.useMemo(
    () => buildStudioListings((designs ?? []) as Design[], session),
    [designs, session],
  );
  const rows = React.useMemo(() => groupStudioListings(listings), [listings]);
  const resultsByListing = React.useMemo(() => {
    const map = new Map<string, StudioProductResult>();
    for (const result of results ?? []) {
      if (result.status === "created" && result.remoteProductId) {
        map.set(result.designId, result);
      }
    }
    return map;
  }, [results]);

  const mockupsById = React.useMemo(
    () => new Map((mockups ?? []).map((mockup) => [mockup.id, mockup as Mockup])),
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

  const tags = React.useMemo(() => parseTags(form.tagsText), [form.tagsText]);
  const fixedCents = dollarsToCents(form.fixedPrice);

  const freshCountFor = React.useCallback(
    (listing: (typeof listings)[number]): number => {
      let fresh = 0;
      for (const mockupId of listingMockupIds(session, listing.listingId)) {
        const mockup = mockupsById.get(mockupId);
        const entry = listingRenderFor(session, listing.listingId, mockupId);
        if (!mockup || !entry) continue;
        const fingerprint = listingImageFingerprint({
          listing,
          mockup,
          placement: placementFor(session, listing.designId),
          saved: placementsByKey.get(`${listing.designId}:${mockupId}`),
        });
        if (isListingRenderFresh(entry, fingerprint)) fresh++;
      }
      return fresh;
    },
    [session, mockupsById, placementsByKey],
  );

  const priceFor = React.useCallback(
    (listingId: string): number | undefined => {
      if (form.priceMode === "custom") {
        return dollarsToCents(form.customPrices[listingId] ?? "");
      }
      return fixedCents;
    },
    [form.priceMode, form.customPrices, fixedCents],
  );

  const setField = <K extends keyof DetailsForm>(key: K, value: DetailsForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    if (saving) return;
    if (listings.length === 0) {
      toast.error("Tick at least one design on the Designs tab first.");
      return;
    }
    if (form.priceMode === "fixed" && fixedCents === undefined) {
      toast.error("Enter a fixed price greater than zero.");
      return;
    }
    if (form.priceMode === "custom") {
      const invalid = listings.filter(
        (listing) => dollarsToCents(form.customPrices[listing.listingId] ?? "") === undefined,
      );
      if (invalid.length > 0) {
        toast.error(
          `Set a price for ${invalid.map((listing) => listing.designName).join(", ")}.`,
        );
        return;
      }
    }

    const listingPrices: Record<string, number> = {};
    if (form.priceMode === "custom") {
      for (const listing of listings) {
        const cents = dollarsToCents(form.customPrices[listing.listingId] ?? "");
        if (cents !== undefined) listingPrices[listing.listingId] = cents;
      }
    }

    const quantity = Number(form.quantity);
    const patch: Partial<StudioSession> = {
      titleTemplate: form.titleTemplate.trim() || "{design} — {product}",
      descriptionTemplate: form.descriptionTemplate,
      tags,
      priceMode: form.priceMode,
      priceCents: fixedCents ?? session.priceCents ?? 1999,
      listingPrices,
      category: form.category.trim(),
      quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1,
    };
    const nextSession: StudioSession = {
      ...session,
      ...patch,
      updatedAt: Date.now(),
    };

    setSaving(true);
    try {
      update(patch);
      const saved = await saveStudioListingDrafts({
        session: nextSession,
        listings,
        productName,
      });
      toast.success(
        `Saved ${saved.saved} listing draft${saved.saved === 1 ? "" : "s"} · ${tags.length} tag${
          tags.length === 1 ? "" : "s"
        } · ${
          form.priceMode === "fixed" && fixedCents !== undefined
            ? `$${(fixedCents / 100).toFixed(2)}`
            : "custom prices"
        }`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the listing details");
    } finally {
      setSaving(false);
    }
  };

  const noImages = listings.filter(
    (listing) => listingMockupIds(session, listing.listingId).length === 0,
  );
  const pendingRenders = listings.filter((listing) => {
    const ids = listingMockupIds(session, listing.listingId);
    return ids.length > 0 && freshCountFor(listing) < ids.length;
  });

  if (!loaded) {
    return <p className="text-[13px] text-ink-muted">Loading the studio session…</p>;
  }

  if (listings.length === 0) {
    return (
      <EmptyState
        icon={<Tags />}
        title="No listings to fill in"
        description="Tick the designs this batch should create on the Designs tab. Each design becomes one listing; a pair becomes one listing shared by both designs."
        actions={[{ label: "Go to Designs", onClick: onGoToDesigns }]}
      />
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <Tags className="h-4 w-4 text-forest" /> Listing details
              </h2>
              <p className="text-[12px] text-ink-muted">
                One set of copy for every listing in this batch.{" "}
                <code className="rounded bg-surface-muted px-1">{"{design}"}</code> and{" "}
                <code className="rounded bg-surface-muted px-1">{"{product}"}</code> are replaced
                per listing.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={onGoToImages}>
                <ArrowLeft className="h-3.5 w-3.5" /> Listing images
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save details
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <FieldLabel htmlFor="listing-title">Title template</FieldLabel>
            <Input
              id="listing-title"
              value={form.titleTemplate}
              onChange={(event) => setField("titleTemplate", event.target.value)}
              placeholder="{design} — {product}"
              maxLength={140}
            />
            <p className="text-[11px] text-ink-subtle">
              Up to 140 characters. The first preview below shows the result for{" "}
              {listings[0]?.designName}.
            </p>
          </div>

          <div className="space-y-1.5">
            <FieldLabel htmlFor="listing-description">Description</FieldLabel>
            <Textarea
              id="listing-description"
              rows={5}
              value={form.descriptionTemplate}
              onChange={(event) => setField("descriptionTemplate", event.target.value)}
              placeholder="The same description for every listing. Use {design} and {product} if you want them named."
              maxLength={5000}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel htmlFor="listing-tags">Tags</FieldLabel>
              <span className="text-[11px] text-ink-subtle">
                {tags.length}/{MAX_TAGS}
              </span>
            </div>
            <Input
              id="listing-tags"
              value={form.tagsText}
              onChange={(event) => setField("tagsText", event.target.value)}
              placeholder="graphic tee, gift for her, retro"
            />
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <Badge key={tag} variant="muted">
                  {tag}
                </Badge>
              ))}
            </div>
            <p className="text-[11px] text-ink-subtle">
              Comma separated. Duplicates are removed and each tag is capped at 20 characters.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="listing-price">Price</FieldLabel>
                <label className="flex items-center gap-2 text-[11px] text-ink-muted">
                  Custom per listing
                  <Switch
                    checked={form.priceMode === "custom"}
                    onCheckedChange={(checked) =>
                      setField("priceMode", checked ? "custom" : "fixed")
                    }
                    aria-label="Use a custom price for each listing"
                  />
                </label>
              </div>
              {form.priceMode === "fixed" ? (
                <div className="space-y-1">
                  <Input
                    id="listing-price"
                    inputMode="decimal"
                    value={form.fixedPrice}
                    onChange={(event) => setField("fixedPrice", event.target.value)}
                    placeholder="24.99"
                    aria-label="Fixed price in dollars"
                  />
                  <p className="text-[11px] text-ink-subtle">
                    Applied to every variant of every listing. Printify takes cents.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 rounded-md border border-border-subtle p-2">
                  {listings.map((listing) => (
                    <div key={listing.listingId} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                        {listing.designName}
                      </span>
                      <div className="w-24">
                        <Input
                          inputMode="decimal"
                          value={form.customPrices[listing.listingId] ?? ""}
                          onChange={(event) =>
                            setField("customPrices", {
                              ...form.customPrices,
                              [listing.listingId]: event.target.value,
                            })
                          }
                          placeholder=""
                          aria-label={`Price for ${listing.designName}`}
                          className="h-8 text-right"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md border border-border-subtle px-3 py-2 text-left text-[12px] font-medium text-ink hover:bg-surface-muted"
                onClick={() => setAdvanced((value) => !value)}
                aria-expanded={advanced}
              >
                Advanced: category and quantity
                <span className="text-[11px] text-ink-subtle">{advanced ? "Hide" : "Show"}</span>
              </button>
              {advanced && (
                <div className="space-y-3 rounded-md border border-border-subtle p-3">
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="listing-category">Category</FieldLabel>
                    <Input
                      id="listing-category"
                      value={form.category}
                      onChange={(event) => setField("category", event.target.value)}
                      placeholder="Optional"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="listing-quantity">Quantity</FieldLabel>
                    <Input
                      id="listing-quantity"
                      type="number"
                      min={1}
                      value={form.quantity}
                      onChange={(event) => setField("quantity", event.target.value)}
                    />
                  </div>
                </div>
              )}
              {noImages.length > 0 && (
                <div className="rounded-md bg-warning-soft px-3 py-2 text-[11px] text-warning">
                  {noImages.length} listing{noImages.length === 1 ? "" : "s"} ha
                  {noImages.length === 1 ? "s" : "ve"} no images selected.{" "}
                  <button type="button" className="underline" onClick={onGoToImages}>
                    Pick listing images
                  </button>
                  .
                </div>
              )}
              {pendingRenders.length > 0 && (
                <div className="rounded-md bg-warning-soft px-3 py-2 text-[11px] text-warning">
                  {pendingRenders.length} listing{pendingRenders.length === 1 ? "" : "s"} ha
                  {pendingRenders.length === 1 ? "s" : "ve"} selected images without a stored
                  render.{" "}
                  <button type="button" className="underline" onClick={onGoToImages}>
                    Render them
                  </button>{" "}
                  so the Export Center uses the images you picked.
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {(["plain", "ink"] as const).map((row) => {
          if (rows[row].length === 0) return null;
          return (
            <section key={row} className="space-y-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-subtle">
                {ROW_LABELS[row]} · {rows[row].length}
              </h3>
              <div className="space-y-2">
                {rows[row].map((listing) => {
                  const result = resultsByListing.get(listing.listingId);
                  const selectedIds = listingMockupIds(session, listing.listingId);
                  const selected = selectedIds.length;
                  const rendered = freshCountFor(listing);
                  const title = renderTitle(form.titleTemplate, listing.designName, productName);
                  const description = renderTemplate(
                    form.descriptionTemplate,
                    listing.designName,
                    productName,
                    "",
                    240,
                  );
                  return (
                    <Card key={listing.listingId} data-listing-id={listing.listingId}>
                      <CardContent className="space-y-2 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-ink">{title}</p>
                            <p className="text-[11px] text-ink-muted">
                              {listing.designName}
                              {listing.partnerName ? ` · with ${listing.partnerName}` : ""}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="muted">{selected} image{selected === 1 ? "" : "s"}</Badge>
                            {selected > 0 && rendered < selected && (
                              <Badge variant="muted">
                                {rendered}/{selected} rendered
                              </Badge>
                            )}
                            <Badge variant="forest">
                              {(() => {
                                const cents = priceFor(listing.listingId);
                                return cents === undefined
                                  ? "Set a price"
                                  : `$${(cents / 100).toFixed(2)}`;
                              })()}
                            </Badge>
                            {result?.remoteProductId ? (
                              <Badge variant="default">Product created</Badge>
                            ) : (
                              <button
                                type="button"
                                className="text-[11px] text-forest underline"
                                onClick={onGoToPanel}
                              >
                                Create product
                              </button>
                            )}
                          </div>
                        </div>
                        {description && (
                          <p className="line-clamp-2 text-[11px] text-ink-muted">{description}</p>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-ink-subtle">
                          <Images className="h-3 w-3" />
                          {tags.length > 0
                            ? tags.slice(0, 6).map((tag) => (
                                <span key={tag} className="rounded bg-surface-muted px-1.5 py-0.5">
                                  {tag}
                                </span>
                              ))
                            : "No tags yet"}
                          {tags.length > 6 && <span>+{tags.length - 6}</span>}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-muted/50 px-3 py-2">
        <p className="text-[11px] text-ink-muted">
          Saving updates the session and the local listing drafts; existing Printify products are
          not changed until you create or update them.
        </p>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save details
        </Button>
      </div>
    </div>
  );
}
