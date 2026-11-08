"use client";

// ---------------------------------------------------------------------------
// Listing details, one design at a time.
//
// One listing per design (or per pair), so the page is organised as one TAB
// PER DESIGN - the same small numbered pills the Mockups panel uses, oldest
// design first: tab 1 is the first uploaded design, matching the Studio's
// design order and the product-creation loop. The tab shows only its number;
// the design's name lives in the tab's aria-label and in the small design
// card beside the form.
//
// The form edits THE OPEN LISTING. "Apply to every design" moves the same
// fields onto the batch templates instead. It is a mode for the BATCH, not a
// property of a design, so opening another tab returns to that design's own
// form (the batch typing is kept while the switch is off). Where each value
// lives:
//
//   * a design's own copy (title/description/tags/category/quantity) is saved
//     into ITS listing draft - the only per-listing copy store there is - so
//     a per-design save writes exactly one draft and never touches the other
//     designs' drafts;
//   * a design's own price is a session override (`listingPrices`), because
//     that is the rule product creation reads (`priceForListing`);
//   * "Apply to every design" writes the batch templates (titleTemplate,
//     descriptionTemplate, tags, price rule) and re-saves every draft from
//     them - the old bulk save's exact semantics, per-design price
//     overrides included in what it replaces.
//
// Seeding: a design that was never edited on its own shows its batch-template
// expansion ({design}/{product} replaced), so the form shows what WILL be
// sent, not blanks. A design with a stored override shows its draft's values
// instead - every bulk save regenerates the drafts from the templates, so the
// two agree unless an override exists.
//
// This used to be a Studio tab and received its session from the Studio page.
// It is a page of its own now, so it loads the session itself - live, like
// the Mockups panel, because the Studio and the agent write the same blob -
// and persists each save by merging it over the LATEST stored session. Only
// the fields this view touched may change: saving the whole local copy would
// silently put a value written elsewhere (a placement, a colour selection)
// back to what this page last saw.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import { Link, navigate } from "@/lib/client/nav";
import { publishActiveListing } from "@/lib/client/agent-context";
import { AssetThumb } from "@/components/asset-thumb";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { FieldLabel, Input, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/primitives";
import {
  buildStudioListings,
  catalogProductName,
  type StudioListing,
} from "@/lib/printify/listing-plan";
import {
  listingMockupIds,
  listingRenderFor,
  MAX_TAGS,
  parseTags,
  placementFor,
  priceForListing,
  renderTemplate,
  renderTitle,
} from "@/lib/printify/studio-session";
import { saveStudioListingDrafts } from "@/lib/printify/listing-drafts";
import { isListingRenderFresh, listingImageFingerprint } from "@/lib/printify/listing-render";
import { emptySession, loadSession, saveSession } from "@/lib/printify/studio-session";
import { useListingCatalog } from "@/views/listings/listing-catalog";
import type {
  Design,
  ListingDraft,
  Mockup,
  Placement,
  StudioSession,
} from "@/types/domain";
import { ArrowLeft, Loader2, Save, Tags } from "lucide-react";

/**
 * The key the batch form lives under while "Apply to every design" is on.
 * The per-design forms are keyed by their listing's id, which can never
 * collide with this sentinel.
 */
const BATCH_KEY = "@batch";

interface DetailsForm {
  title: string;
  description: string;
  tagsText: string;
  /** The open listing's own price, in dollars. Used while the toggle is off. */
  price: string;
  /** The batch's fixed/custom rule. Used while the toggle is on. */
  priceMode: "fixed" | "custom";
  fixedPrice: string;
  customPrices: Record<string, string>;
  category: string;
  quantity: string;
}

/** A form plus the seed it came from: "pristine" means the two still match. */
interface FormEntry {
  form: DetailsForm;
  seed: DetailsForm;
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

function customPricesFromSession(session: StudioSession): Record<string, string> {
  const prices: Record<string, string> = {};
  for (const [id, cents] of Object.entries(session.listingPrices ?? {})) {
    prices[id] = centsToDollars(cents);
  }
  return prices;
}

/** The batch form: the raw templates, exactly what the session stores. */
function batchFormFromSession(session: StudioSession): DetailsForm {
  return {
    title: session.titleTemplate ?? "",
    description: session.descriptionTemplate ?? "",
    tagsText: (session.tags ?? []).join(", "),
    price: "",
    priceMode: session.priceMode === "custom" ? "custom" : "fixed",
    fixedPrice: centsToDollars(session.priceCents),
    customPrices: customPricesFromSession(session),
    category: session.category ?? "",
    quantity: String(session.quantity && session.quantity > 0 ? session.quantity : 1),
  };
}

/**
 * The open listing's form.
 *
 * The copy reads the design's OWN draft first and falls back to the batch
 * templates expanded with {design}/{product}. Reading the draft first is what
 * makes a per-design override survive leaving the page: the draft is where a
 * per-design save stores its copy, and because every bulk save regenerates
 * the drafts from the templates, an untouched design's draft equals the
 * expansion below - the two disagree only when an override exists.
 *
 * The price stays a LIVE rule rather than the draft's snapshot: it is what
 * the next save writes and what product creation (`priceForListing`) sends.
 */
function designFormFromSession(
  session: StudioSession,
  listing: StudioListing,
  productName: string,
  draft: ListingDraft | undefined,
): DetailsForm {
  const base = batchFormFromSession(session);
  return {
    title: draft?.title ?? renderTitle(session.titleTemplate, listing.designName, productName),
    description:
      draft?.description ??
      renderTemplate(session.descriptionTemplate, listing.designName, productName, "", 5000),
    tagsText: draft ? (draft.tags ?? []).join(", ") : base.tagsText,
    price: centsToDollars(priceForListing(session, listing.listingId)),
    priceMode: base.priceMode,
    fixedPrice: base.fixedPrice,
    customPrices: base.customPrices,
    category: draft?.category ?? base.category,
    quantity: String(
      draft?.quantity && draft.quantity > 0
        ? draft.quantity
        : session.quantity && session.quantity > 0
          ? session.quantity
          : 1,
    ),
  };
}

function seedFormFor(
  key: string,
  session: StudioSession,
  listingsById: Map<string, StudioListing>,
  draftsByDesign: Map<string, ListingDraft>,
  productName: string,
): DetailsForm {
  if (key === BATCH_KEY) return batchFormFromSession(session);
  const listing = listingsById.get(key);
  // Unreachable in practice: entries whose listing left the batch are
  // dropped before this runs. Kept total so the type cannot lie.
  if (!listing) return batchFormFromSession(session);
  return designFormFromSession(
    session,
    listing,
    productName,
    draftsByDesign.get(listing.listingId),
  );
}

function customPricesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function formEquals(a: DetailsForm, b: DetailsForm): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.tagsText === b.tagsText &&
    a.price === b.price &&
    a.priceMode === b.priceMode &&
    a.fixedPrice === b.fixedPrice &&
    a.category === b.category &&
    a.quantity === b.quantity &&
    customPricesEqual(a.customPrices, b.customPrices)
  );
}

export function ListingDetailsView() {
  const designs = useLiveQuery(() => db.designs.toArray(), []);
  const mockups = useLiveQuery(() => db.mockups.toArray(), []);
  const placements = useLiveQuery(() => db.placements.toArray(), []);
  const drafts = useLiveQuery(() => db.listingDrafts.toArray(), []);
  const catalog = useListingCatalog();

  // --- session ---------------------------------------------------------------
  // Live, not one-shot: the Studio page, the Mockups panel and the agent all
  // write the same blob, and this page must see those writes without a reload.
  const liveSession = useLiveQuery(() => loadSession(), []);
  const [session, setSession] = React.useState<StudioSession>(() => emptySession());
  /** True once the stored session has arrived, so the form hydrates once. */
  const [loaded, setLoaded] = React.useState(false);

  /**
   * The product's display name, for `{product}` in the copy. It comes from the
   * shared catalogue the Studio uses, so the preview and the saved draft
   * always expand to the same string.
   */
  const productName = React.useMemo(
    () => catalogProductName(catalog.blueprints, session.blueprintId),
    [catalog.blueprints, session.blueprintId],
  );

  /**
   * Patches captured but not persisted yet.
   *
   * The echo-merge below re-applies them, and the queued write drains them,
   * so a save can never be lost between the click and its write.
   */
  const pendingPatch = React.useRef<Partial<StudioSession>>({});
  /**
   * Writes are queued: two saves in quick succession must not interleave
   * their read-latest/write steps, or the second write would be built from a
   * snapshot that predates the first and silently drop it.
   */
  const writeQueue = React.useRef<Promise<void>>(Promise.resolve());

  React.useEffect(() => {
    if (!liveSession) return;
    // Re-apply patches still waiting in the write queue: the echo of an
    // earlier save can land while a newer one has not been persisted yet.
    setSession({ ...liveSession, ...pendingPatch.current });
    // `loaded` is state set HERE, not a derived `liveSession !== undefined`:
    // the session state and the flag must land in the same batch, or the form
    // below could hydrate one render early - from an empty session.
    setLoaded(true);
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

  const [saving, setSaving] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [applyAll, setApplyAll] = React.useState(false);
  /** The tab the user opened; null means "the first listing". */
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const listings = React.useMemo(
    () => buildStudioListings((designs ?? []) as Design[], session),
    [designs, session],
  );
  const listingsById = React.useMemo(
    () => new Map(listings.map((listing) => [listing.listingId, listing])),
    [listings],
  );
  const draftsByDesign = React.useMemo(() => {
    const map = new Map<string, ListingDraft>();
    for (const draft of drafts ?? []) {
      const designId = draft.designId;
      if (!designId) continue;
      // Newest wins, matching how saveStudioListingDrafts picks the row it
      // re-saves (newest by updatedAt, never by createdAt).
      const existing = map.get(designId);
      if (!existing || draft.updatedAt >= existing.updatedAt) map.set(designId, draft);
    }
    return map;
  }, [drafts]);

  const openListing = React.useMemo(
    () => listings.find((listing) => listing.listingId === activeId) ?? listings[0],
    [listings, activeId],
  );
  const openKey = applyAll ? BATCH_KEY : (openListing?.listingId ?? BATCH_KEY);

  // Tell the agent panel which listing is open. The panel is mounted in the
  // app shell, so it cannot read this page's state directly.
  React.useEffect(() => {
    publishActiveListing(
      openListing
        ? { listingId: openListing.listingId, designName: openListing.designName }
        : undefined,
    );
    return () => publishActiveListing(undefined);
  }, [openListing]);

  // --- the forms -------------------------------------------------------------
  /**
   * One form per target: the open listing's design, plus the batch form while
   * the toggle is on. Keeping per-design forms in a map is what lets the user
   * switch tabs without losing what they typed on the previous one.
   */
  const [forms, setForms] = React.useState<Record<string, FormEntry>>({});

  React.useEffect(() => {
    if (!loaded) return;
    setForms((prev) => {
      let changed = false;
      const next: Record<string, FormEntry> = {};
      for (const [key, entry] of Object.entries(prev)) {
        // A listing that left the batch (unticked in the Studio, deleted, or
        // a pair re-joined) has nothing left to edit: drop its form.
        if (key !== BATCH_KEY && !listingsById.has(key)) {
          changed = true;
          continue;
        }
        const seed = seedFormFor(key, session, listingsById, draftsByDesign, productName);
        if (formEquals(entry.form, entry.seed)) {
          // Pristine: the form still holds exactly what it was seeded with,
          // so re-seeding cannot lose typing - and writes made elsewhere (the
          // Studio, the agent, an apply-to-all save) show up without a reload.
          if (!formEquals(entry.form, seed)) {
            next[key] = { form: seed, seed };
            changed = true;
          } else {
            next[key] = entry;
          }
        } else if (!formEquals(entry.seed, seed)) {
          // Edited: keep the user's values, but re-base them on the current
          // seed so "pristine" keeps meaning "matches what would be sent".
          next[key] = { form: entry.form, seed };
          changed = true;
        } else {
          next[key] = entry;
        }
      }
      // Make sure the open form exists (first open, or the toggle just moved
      // the fields onto another target). Until this lands, the render shows
      // the same deterministic seed, so nothing foreign flashes on screen.
      if (!next[openKey]) {
        const seed = seedFormFor(openKey, session, listingsById, draftsByDesign, productName);
        next[openKey] = { form: seed, seed };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [loaded, session, productName, listingsById, draftsByDesign, applyAll, openKey]);

  const openEntry = openListing
    ? forms[applyAll ? BATCH_KEY : openListing.listingId]
    : undefined;
  const shown = openEntry?.form ?? seedFormFor(openKey, session, listingsById, draftsByDesign, productName);

  const tags = React.useMemo(() => parseTags(shown.tagsText), [shown.tagsText]);
  const fixedCents = dollarsToCents(shown.fixedPrice);
  const designCents = dollarsToCents(shown.price);

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

  const freshCountFor = React.useCallback(
    (listing: StudioListing): number => {
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

  const setField = <K extends keyof DetailsForm>(field: K, value: DetailsForm[K]) => {
    if (!openListing) return;
    setForms((prev) => {
      const key = applyAll ? BATCH_KEY : openListing.listingId;
      const seed = seedFormFor(key, session, listingsById, draftsByDesign, productName);
      const entry = prev[key];
      return {
        ...prev,
        [key]: { form: { ...(entry?.form ?? seed), [field]: value }, seed: entry?.seed ?? seed },
      };
    });
  };

  const handleToggleApplyAll = (on: boolean) => {
    if (!openListing) return;
    setApplyAll(on);
    // Seed the target's form immediately, so the fields never show another
    // target's values; the effect above keeps it in step afterwards. An
    // existing entry is kept on purpose: returning to a tab restores what the
    // user was typing there.
    setForms((prev) => {
      const key = on ? BATCH_KEY : openListing.listingId;
      if (prev[key]) return prev;
      const seed = seedFormFor(key, session, listingsById, draftsByDesign, productName);
      return { ...prev, [key]: { form: seed, seed } };
    });
  };

  /**
   * Opens a design's tab.
   *
   * A tab always opens in per-design mode: "Apply to every design" is a mode
   * for the BATCH templates, not a property of a design, so carrying it across
   * a tab switch would make the next "Save details" on that tab overwrite
   * every design's draft. The batch form's typing is kept in `forms`, so
   * turning the switch back on restores it.
   */
  const selectListing = (listingId: string) => {
    if (listingId !== openListing?.listingId) setApplyAll(false);
    setActiveId(listingId);
  };

  const save = async () => {
    if (saving || !openListing) return;
    const form = shown;
    const parsedTags = parseTags(form.tagsText);
    const quantity = Number(form.quantity);
    const normalizedQuantity =
      Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1;

    if (applyAll) {
      // ---------------------------------------------------------------------
      // Apply to every design: the old bulk save, unchanged. The templates
      // are written to the session (so designs ticked later inherit them) and
      // every draft is regenerated from them - which is also what replaces
      // per-design copy and price overrides with the fixed/custom rule.
      // ---------------------------------------------------------------------
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

      const patch: Partial<StudioSession> = {
        titleTemplate: form.title.trim() || "{design} — {product}",
        descriptionTemplate: form.description,
        tags: parsedTags,
        priceMode: form.priceMode,
        priceCents: fixedCents ?? session.priceCents ?? 1999,
        listingPrices,
        category: form.category.trim(),
        quantity: normalizedQuantity,
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
          // The user just edited the batch templates: the drafts must follow.
          copyMode: "regenerate",
        });
        // The drafts were regenerated from the new templates, so the
        // per-design forms re-seed from them: their unsaved edits are
        // superseded by exactly this write. The batch form shows the values
        // that were written (trimmed template, parsed tags, normalised
        // quantity) rather than the raw typing, so the page never claims
        // something the session does not store.
        const savedBatch = batchFormFromSession(nextSession);
        setForms((): Record<string, FormEntry> => ({
          [BATCH_KEY]: { form: savedBatch, seed: savedBatch },
        }));
        toast.success(
          `Saved ${saved.saved} listing draft${saved.saved === 1 ? "" : "s"} · ${
            parsedTags.length
          } tag${parsedTags.length === 1 ? "" : "s"} · ${
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
      return;
    }

    // -------------------------------------------------------------------------
    // This design only.
    // -------------------------------------------------------------------------
    const listing = openListing;
    const cents = designCents;
    if (cents === undefined) {
      toast.error(`Set a price for ${listing.designName}.`);
      return;
    }

    // A price override is stored only when it differs from the listing's
    // current effective price: an unchanged value stays on the batch rule, so
    // editing a title never flips the batch's price mode. When it does differ,
    // the batch rule moves to custom and every active listing's price is
    // written explicitly - no other listing changes value, and none is left
    // on a "Set a price" state it never chose.
    let pricePatch: Partial<StudioSession> = {};
    if (cents !== priceForListing(session, listing.listingId)) {
      // Start from what is stored, so an override that belongs to a design
      // outside this batch survives. The other ACTIVE listings are pinned to
      // the price they already resolve to, because moving the rule to "custom"
      // must not change any of them; only the open listing gets the new value.
      const listingPrices: Record<string, number> = { ...(session.listingPrices ?? {}) };
      for (const other of listings) {
        if (other.listingId !== listing.listingId) {
          listingPrices[other.listingId] = priceForListing(session, other.listingId);
        }
      }
      listingPrices[listing.listingId] = cents;
      pricePatch = {
        priceMode: "custom",
        priceCents: session.priceCents ?? 1999,
        listingPrices,
      };
    }

    // The copy travels as a HYBRID session: this design's values stand in for
    // the templates, but only THIS listing is passed, so exactly one draft is
    // written and the other designs' drafts (and the stored templates) are
    // untouched. The image fields still come from the real session, so the
    // three-case rule in nextListingImageState behaves exactly as it does for
    // a bulk save.
    const perDesignSession: StudioSession = {
      ...session,
      ...pricePatch,
      titleTemplate: form.title.trim() || "{design} — {product}",
      descriptionTemplate: form.description,
      tags: parsedTags,
      category: form.category.trim(),
      quantity: normalizedQuantity,
      updatedAt: Date.now(),
    };
    // The seed this design's form gets after the save: exactly what was
    // written. Without it, the pristine re-seed could snap the fields away
    // from the values the user just saved.
    const savedSeed: DetailsForm = {
      title: renderTitle(perDesignSession.titleTemplate, listing.designName, productName),
      description: renderTemplate(
        perDesignSession.descriptionTemplate,
        listing.designName,
        productName,
        "",
        5000,
      ),
      tagsText: parsedTags.join(", "),
      price: centsToDollars(cents) ?? "",
      priceMode: perDesignSession.priceMode ?? "fixed",
      fixedPrice: centsToDollars(perDesignSession.priceCents),
      customPrices: customPricesFromSession(perDesignSession),
      category: perDesignSession.category ?? "",
      quantity: String(normalizedQuantity),
    };

    setSaving(true);
    try {
      if (Object.keys(pricePatch).length > 0) update(pricePatch);
      await saveStudioListingDrafts({
        session: perDesignSession,
        listings: [listing],
        productName,
        // This design's form is the source of truth for its own copy.
        copyMode: "regenerate",
      });
      // Show exactly what was written. Keeping the raw typing would leave the
      // form claiming values the draft does not have: a blank title (the save
      // falls back to the default expansion), tags beyond the 13-tag cap, an
      // un-normalised quantity, or text that was trimmed on the way in.
      setForms((prev) => ({
        ...prev,
        [listing.listingId]: { form: savedSeed, seed: savedSeed },
      }));
      toast.success(
        `Saved ${listing.designName} · ${parsedTags.length} tag${
          parsedTags.length === 1 ? "" : "s"
        } · $${(cents / 100).toFixed(2)}`,
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

  // Designs in the library that the batch would not create. Counted, never
  // ticked: an empty selection means NO batch, and adding a design to the
  // scope is the user's decision on the Designs tab.
  const unscopedCount = React.useMemo(
    () => (designs ?? []).filter((design) => !session.designIds.includes(design.id)).length,
    [designs, session.designIds],
  );

  // The form's seed is decided by the drafts (an edited design shows its
  // draft, not the template expansion), so the first render must not happen
  // before they are here - otherwise an edited design would flash the
  // expansion, which is a value it will never send.
  if (!loaded || designs === undefined || drafts === undefined) {
    return (
      <div className="mx-auto max-w-6xl p-8">
        <p className="text-[13px] text-ink-muted">Loading the studio session…</p>
      </div>
    );
  }

  if (listings.length === 0 || !openListing) {
    return (
      <div className="mx-auto max-w-6xl p-8">
        <EmptyState
          icon={<Tags />}
          title="No listings to fill in"
          description="Tick the designs this batch should create on the Designs tab of the Printify Studio. Each design becomes one listing; a pair becomes one listing shared by both designs."
          actions={[
            { label: "Go to Designs", onClick: () => navigate("/printify-studio") },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-5 sm:p-8">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <Tags className="h-4 w-4 text-forest" /> Listing details
              </h2>
              <p className="text-[12px] text-ink-muted">
                One listing per design — a pair is one listing. Fill each design's details on its
                numbered tab, or flip “Apply to every design” to write them all at once.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/printify-studio">Designs & batch</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/listing-images">
                  <ArrowLeft className="h-3.5 w-3.5" /> Listing images
                </Link>
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {applyAll ? "Save all designs" : "Save details"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* The per-design tabs: one small numbered tab per ACTIVE listing,
          oldest first - tab 1 is the first uploaded design, matching the
          Studio's design order and the product-creation loop. The number is
          all that is visible; the name stays the accessible name, which is
          what screen readers and tests address. Everything to the right -
          the design card and the form - is THAT listing only. */}
      <div className="flex items-end gap-2 border-b border-border-subtle">
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" id="design-tabs">
          {listings.map((listing, index) => {
            const active = listing.listingId === openListing.listingId;
            return (
              <button
                key={listing.listingId}
                type="button"
                aria-pressed={active}
                onClick={() => selectListing(listing.listingId)}
                title={listing.designName}
                aria-label={listing.designName}
                className={`border-b-2 px-2.5 py-1 text-[12px] font-semibold transition-colors ${
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
          {listings.length} in batch
        </Badge>
      </div>

      {unscopedCount > 0 && (
        <p className="text-[11px] text-ink-subtle">
          {unscopedCount} design{unscopedCount === 1 ? "" : "s"} in the library{" "}
          {unscopedCount === 1 ? "is" : "are"} not in this batch.{" "}
          <Link href="/printify-studio" className="text-forest underline">
            Tick them in the Printify Studio
          </Link>{" "}
          to add listings — nothing is ticked automatically.
        </p>
      )}

      <div className="grid items-start gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
        {/* The design card is deliberately small: it names and shows the
            listing being edited, while the form stays the dominant column. */}
        <Card className="w-40 shrink-0" data-listing-id={openListing.listingId}>
          <CardContent className="space-y-2 p-2">
            <div className="aspect-square overflow-hidden rounded-md bg-surface-muted">
              <AssetThumb
                assetId={openListing.artworkAssetId}
                className="h-full w-full"
                alt={openListing.designName}
              />
            </div>
            <p className="truncate text-[12px] font-medium text-ink" title={openListing.designName}>
              {openListing.designName}
            </p>
            <div className="flex flex-wrap gap-1">
              {openListing.partnerName && (
                <Badge variant="muted" title={`One listing with ${openListing.partnerName}`}>
                  Pair
                </Badge>
              )}
              {openListing.row === "ink" && <Badge variant="forest">Ink variants</Badge>}
            </div>
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          {/* The tabs show numbers, so this line is the only place the open
              design's name is spelled out - the same convention as the
              Mockups panel's context line above its canvas. */}
          <p className="text-[12px] text-ink-subtle">
            {openListing.designName}
            {openListing.partnerName ? ` · one listing with ${openListing.partnerName}` : ""}
          </p>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-[12px] font-medium text-ink">
                Apply to every design
                <Switch
                  checked={applyAll}
                  onCheckedChange={handleToggleApplyAll}
                  aria-label="Apply to every design"
                />
              </label>
              {applyAll && (
                <span className="text-[11px] text-forest">
                  applies to all {listings.length} design{listings.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {applyAll ? (
              <p className="rounded-md bg-surface-muted px-3 py-2 text-[11px] text-ink-muted">
                These fields edit the batch templates. Saving writes them to every listing draft and
                updates the session, so designs ticked later inherit them. Prices follow the
                fixed/custom rule below — per-design price overrides are replaced.
              </p>
            ) : (
              <p className="text-[11px] text-ink-muted">
                Editing <strong>{openListing.designName}</strong> only — the other designs keep
                their own details.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <FieldLabel htmlFor="listing-title">{applyAll ? "Title template" : "Title"}</FieldLabel>
            <Input
              id="listing-title"
              value={shown.title}
              onChange={(event) => setField("title", event.target.value)}
              placeholder={applyAll ? "{design} — {product}" : "Title for this listing"}
              maxLength={140}
            />
            {applyAll ? (
              <p className="text-[11px] text-ink-subtle">
                Up to 140 characters.{" "}
                <code className="rounded bg-surface-muted px-1">{"{design}"}</code> and{" "}
                <code className="rounded bg-surface-muted px-1">{"{product}"}</code> are replaced per
                listing — for {openListing.designName} this sends:{" "}
                <span className="text-ink">
                  {renderTitle(shown.title, openListing.designName, productName)}
                </span>
              </p>
            ) : (
              <p className="text-[11px] text-ink-subtle">
                Up to 140 characters. Saved with this design's listing draft.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <FieldLabel htmlFor="listing-description">Description</FieldLabel>
            <Textarea
              id="listing-description"
              rows={5}
              value={shown.description}
              onChange={(event) => setField("description", event.target.value)}
              placeholder={
                applyAll
                  ? "The same description for every listing. Use {design} and {product} if you want them named."
                  : "Description for this listing."
              }
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
              value={shown.tagsText}
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
              {applyAll ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel htmlFor="listing-price">Price</FieldLabel>
                    <label className="flex items-center gap-2 text-[11px] text-ink-muted">
                      Custom per listing
                      <Switch
                        checked={shown.priceMode === "custom"}
                        onCheckedChange={(checked) =>
                          setField("priceMode", checked ? "custom" : "fixed")
                        }
                        aria-label="Custom per listing"
                      />
                    </label>
                  </div>
                  {shown.priceMode === "fixed" ? (
                    <div className="space-y-1">
                      <Input
                        id="listing-price"
                        inputMode="decimal"
                        value={shown.fixedPrice}
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
                              value={shown.customPrices[listing.listingId] ?? ""}
                              onChange={(event) =>
                                setField("customPrices", {
                                  ...shown.customPrices,
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
                </>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel htmlFor="listing-price">Price for this listing</FieldLabel>
                    {designCents === undefined && <Badge variant="warning">Set a price</Badge>}
                  </div>
                  <Input
                    id="listing-price"
                    inputMode="decimal"
                    value={shown.price}
                    onChange={(event) => setField("price", event.target.value)}
                    placeholder="24.99"
                    aria-label="Price for this listing in dollars"
                  />
                  <p className="text-[11px] text-ink-subtle">
                    Applied to every variant of this listing's product. Printify takes cents.
                  </p>
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
                      value={shown.category}
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
                      value={shown.quantity}
                      onChange={(event) => setField("quantity", event.target.value)}
                    />
                  </div>
                </div>
              )}
              {noImages.length > 0 && (
                <div className="rounded-md bg-warning-soft px-3 py-2 text-[11px] text-warning">
                  {noImages.length} listing{noImages.length === 1 ? "" : "s"} ha
                  {noImages.length === 1 ? "s" : "ve"} no images selected.{" "}
                  <Link href="/listing-images" className="underline">
                    Pick listing images
                  </Link>
                  .
                </div>
              )}
              {pendingRenders.length > 0 && (
                <div className="rounded-md bg-warning-soft px-3 py-2 text-[11px] text-warning">
                  {pendingRenders.length} listing{pendingRenders.length === 1 ? "" : "s"} ha
                  {pendingRenders.length === 1 ? "s" : "ve"} selected images without a stored
                  render.{" "}
                  <Link href="/listing-images" className="underline">
                    Render them
                  </Link>{" "}
                  so the Export Center uses the images you picked.
                </div>
              )}
            </div>
          </div>

          {!applyAll && (
            <p className="text-[11px] text-ink-subtle">
              Saved to this design's listing draft — the Export Center reads it. New Printify
              products are created from the batch copy, so flip on “Apply to every design” to change
              what they get.
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-muted/50 px-3 py-2">
        <p className="text-[11px] text-ink-muted">
          {applyAll
            ? "Saving writes the batch templates and every listing draft; Printify products change only on Send/Publish."
            : "Saving writes this design's draft and price; other drafts are untouched."}
        </p>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {applyAll ? "Save all designs" : "Save details"}
        </Button>
      </div>
    </div>
  );
}
