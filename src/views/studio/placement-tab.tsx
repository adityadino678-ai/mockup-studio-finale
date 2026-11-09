"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db, getSetting, setSetting } from "@/lib/db/schema";
import { createStudioProducts } from "@/lib/client/studio-create";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, Separator } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/primitives";
import {
  DesignAdjustmentPanel,
  DesignGallery,
  splitDesignsForSession,
  productColourGroups,
  swatchesForPlan,
  type DesignColours,
  type DesignSwatch,
} from "@/views/studio/design-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  inkArtworkProblems,
  pairedDesignIds,
  pairForDesign,
  planDesignColours,
  planPairedDesignColours,
  setInkPairRole,
  summariseColourGroups,
  withInkPair,
  withoutInkPair,
} from "@/lib/printify/design-colours";
import {
  buildStudioPlan,
  describeMissingInk,
  emptyPanelProblems,
  planVariantCounts,
  studioPartitionProblems,
  undecidedInkProblems,
} from "@/lib/printify/studio-plan";
import { inkProblems, placementFor, remapListingState, RESULTS_KEY, ROWS } from "@/lib/printify/studio-session";
import { buildStudioListings } from "@/lib/printify/listing-plan";
import { remapListingDraftOwner } from "@/lib/printify/listing-drafts";
import { saveStudioListingDrafts } from "@/lib/printify/listing-drafts";
import type { StudioCatalogState } from "@/views/printify-studio-page";
import type { StudioProductResult, StudioSession, Design } from "@/types/domain";
import type { DesignCardData } from "@/components/studio/design-card";
import { AlertTriangle, Crosshair, Loader2, Package, Send } from "lucide-react";

interface PlacementTabProps {
  session: StudioSession;
  update: (patch: Partial<StudioSession>) => void;
  catalog: StudioCatalogState;
  hexFor: (name: string) => string;
  onGoToColors: () => void;
}

/** One design in the gallery, with the size of its artwork. */
interface GalleryEntry {
  design: Design;
  dimensions: string;
}

export function PlacementTab({ session, update, catalog, hexFor, onGoToColors }: PlacementTabProps) {
  const [results, setResults] = React.useState<StudioProductResult[]>([]);
  const [creating, setCreating] = React.useState(false);
  const [progress, setProgress] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [recreate, setRecreate] = React.useState(false);
  /** The design whose placement is being adjusted, if any. */
  const [editingDesignId, setEditingDesignId] = React.useState<string | null>(null);
  const problemsRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * The designs, with the size of their artwork.
   *
   * The sizes are needed by the cards, and they come from the assets table:
   * ONE bulk read for the whole gallery, never one read per card.
   */
  const gallery = useLiveQuery(async () => {
    const all = await db.designs.toArray();
    const metas = await db.assets.bulkGet(all.map((d) => d.originalAssetId));
    const metaMap = new Map<string, { width: number; height: number }>();
    for (const meta of metas) {
      if (meta) metaMap.set(meta.id, { width: meta.width, height: meta.height });
    }
    return all
      .map((d) => {
        const meta = metaMap.get(d.originalAssetId);
        return {
          design: d,
          dimensions: meta ? `${meta.width}×${meta.height}` : "—",
        };
      })
      .sort((a, b) => a.design.createdAt - b.design.createdAt);
  }, []);

  const designs = React.useMemo(() => (gallery ?? []).map((g) => g.design), [gallery]);

  /** The pairs of designs that print as ONE listing. */
  const inkPairs = React.useMemo(() => session.inkPairs ?? [], [session.inkPairs]);
  const pairIds = React.useMemo(() => pairedDesignIds(inkPairs), [inkPairs]);

  /** Ticks / unticks a design as "has ink variants", from this tab too. */
  const toggleInkPair = (id: string) => {
    const ids = session.inkPairIds ?? [];
    if (ids.includes(id)) {
      // Unticking one half of a pair breaks the pair, so the other half never
      // points at artwork that is no longer marked for the ink colours.
      const found = pairForDesign(inkPairs, id);
      const members = found ? [found.pair.blackInkDesignId, found.pair.whiteInkDesignId] : [id];
      update({
        inkPairIds: ids.filter((x) => !members.includes(x)),
        inkPairs: withoutInkPair(inkPairs, id),
      });
      return;
    }
    update({ inkPairIds: [...ids, id] });
  };

  /** Moves a paired design to the other half of its pair. */
  const setRole = (id: string, role: "black" | "white") => {
    const before = pairForDesign(inkPairs, id);
    const nextPairs = setInkPairRole(inkPairs, id, role);
    const after = pairForDesign(nextPairs, id);
    const fromId = before?.pair.blackInkDesignId;
    const toId = after?.pair.blackInkDesignId;
    if (fromId && toId && fromId !== toId) {
      update({
        inkPairs: nextPairs,
        ...remapListingState(session, fromId, toId),
      });
      void remapListingDraftOwner(fromId, toId).catch(() => {
        // The session remap already happened; the next save rewrites the draft.
      });
    } else {
      update({ inkPairs: nextPairs });
    }
  };

  /** Breaks the pair a design belongs to. */
  const unpair = (id: string) => {
    const found = pairForDesign(inkPairs, id);
    if (!found) return;
    const members = [found.pair.blackInkDesignId, found.pair.whiteInkDesignId];
    update({
      inkPairs: withoutInkPair(inkPairs, id),
      inkPairIds: (session.inkPairIds ?? []).filter((x) => !members.includes(x)),
    });
  };

  /**
   * Pairs the two ink-ticked designs as one listing, from this tab too.
   *
   * Both halves join the batch scope, because a pair IS a listing: leaving
   * one half out would create nothing for the other.
   */
  const pairTwo = (blackId: string, whiteId: string) => {
    if (!blackId || !whiteId || blackId === whiteId) return;
    const existing = pairForDesign(inkPairs, blackId);
    if (
      existing &&
      (existing.pair.blackInkDesignId === whiteId || existing.pair.whiteInkDesignId === whiteId)
    ) {
      return;
    }
    update({
      inkPairs: withInkPair(inkPairs, blackId, whiteId),
      inkPairIds: [...new Set([...(session.inkPairIds ?? []), blackId, whiteId])],
      designIds: [...new Set([...session.designIds, blackId, whiteId])],
    });
  };

  /** The partner's name and this design's role, for the card. */
  const pairInfo = React.useCallback(
    (id: string) => {
      const found = pairForDesign(inkPairs, id);
      if (!found) return undefined;
      const partnerId =
        found.role === "black" ? found.pair.whiteInkDesignId : found.pair.blackInkDesignId;
      const partner = designs.find((d) => d.id === partnerId);
      return { partnerName: partner?.name ?? "a deleted design", role: found.role };
    },
    [inkPairs, designs],
  );

  /**
   * The gallery split into the two rows.
   *
   * The split is the user's own ticks from the Designs tab, so the panel and
   * that tab agree by construction.
   */
  const galleryRows = React.useMemo(() => {
    const split = splitDesignsForSession(designs ?? [], session);
    const plainIds = new Set(split.plain.map((d) => d.id));
    const plain: GalleryEntry[] = [];
    const ink: GalleryEntry[] = [];
    for (const entry of gallery ?? []) {
      if (plainIds.has(entry.design.id)) plain.push(entry);
      else ink.push(entry);
    }
    return { plain, ink };
  }, [designs, gallery, session]);

  /**
   * What each design prints on, for its card.
   *
   * The panel decides it: an unticked design prints the plain panel's colours
   * with its main artwork; a ticked one prints the ink panel's colours, split
   * by the black/white ink switch.
   */
  const designColours = React.useCallback(
    (design: DesignCardData): DesignColours => {
      const groups = productColourGroups(session);
      const pair = pairForDesign(inkPairs, design.id);
      const plan = pair
        ? planPairedDesignColours(pair.role, groups)
        : planDesignColours(
            {
              hasInkPair: (session.inkPairIds ?? []).includes(design.id),
              hasBlackInk: Boolean(design.blackInkAssetId),
              hasWhiteInk: Boolean(design.whiteInkAssetId),
            },
            groups,
          );
      return { colors: plan.colors, swatches: swatchesForPlan(plan, hexFor) };
    },
    [session, hexFor, inkPairs],
  );

  /** The colour swatches of a row, so every card in it shows its colours. */
  const swatchesForRow = React.useCallback(
    (row: "plain" | "ink"): DesignSwatch[] =>
      (session.rows[row]?.colors ?? []).map((name) => {
        const hex = hexFor(name);
        if (row === "plain") return { name, hex };
        const ink = session.rows.ink?.blackInkColors?.includes(name)
          ? ("black" as const)
          : session.rows.ink?.whiteInkColors?.includes(name)
            ? ("white" as const)
            : ("ambiguous" as const);
        return { name, hex, ink };
      }),
    [session.rows, hexFor],
  );

  React.useEffect(() => {
    (async () => {
      const stored = await getSetting<StudioProductResult[]>(RESULTS_KEY, []);
      if (Array.isArray(stored)) setResults(stored);
    })();
  }, []);

  /** Persists the results without ever failing the creation run. */
  const persistResults = async (next: StudioProductResult[]) => {
    setResults(next);
    try {
      await setSetting(RESULTS_KEY, next.slice(0, 200));
    } catch {
      // The products exist on Printify even when the local write fails, so this
      // must never be reported as a creation failure.
      toast.error("The products were created, but the list could not be saved in this browser.");
    }
  };

  // --- print areas -----------------------------------------------------------
  const printAreas = React.useMemo(() => {
    const map = new Map<string, { position: string; width: number; height: number }>();
    for (const v of catalog.variants) {
      for (const p of v.placeholders ?? []) {
        if (!p.position) continue;
        const prev = map.get(p.position);
        if (!prev || (p.width ?? 1e9) * (p.height ?? 1e9) < (prev.width ?? 1e9) * (prev.height ?? 1e9)) {
          map.set(p.position, { position: p.position, width: p.width ?? 3000, height: p.height ?? 3000 });
        }
      }
    }
    return [...map.values()];
  }, [catalog.variants]);

  const area = React.useMemo(
    () => printAreas.find((a) => a.position === session.universalPlacement.position) ?? printAreas[0],
    [printAreas, session.universalPlacement.position],
  );

  // --- the batch scope -------------------------------------------------------
  // Only the designs ticked in the Designs tab are created. An empty
  // selection means NO batch, not "every design" - otherwise a stray click
  // on "Create" would turn one design into fifty products.
  const scope = React.useMemo(() => {
    const wanted = new Set(session.designIds);
    return (designs ?? []).filter((d) => wanted.has(d.id));
  }, [designs, session.designIds]);

  // --- the plan --------------------------------------------------------------
  /**
   * What each design will be printed with, for this product.
   *
   * A PAIR is one product: the black-ink design prints the plain and
   * black-ink colours, its partner the white-ink ones, and the black-ink
   * design owns the listing (name, title, price, placement). Both designs
   * must be ticked - a half-pair is left as an ordinary design rather than
   * guessed at.
   *
   * An UNPAIRED design keeps the old rule and always covers EVERY colour of
   * the product: the plain ones with the main artwork, the ink ones with the
   * ink artwork the design actually has.
   */
  const plan = React.useMemo(
    () => buildStudioPlan(designs, session, catalog.variants),
    [designs, session, catalog.variants],
  );

  /**
   * The colour counts behind the plan, for the informational summary.
   *
   * Each panel feeds its own row, so the summary reports them separately: the
   * no-ink row's colours, then the ink row's split into black and white ink.
   * A colour in BOTH panels is named separately and described as intentional,
   * because each row prints it with its own artwork. These numbers never block
   * creation.
   */
  const colourSummary = React.useMemo(
    () => summariseColourGroups(productColourGroups(session)),
    [session],
  );

  /** The enabled variant count for each product row, with the sizes applied. */
  const itemVariantCounts = React.useMemo(
    () => (plan ? planVariantCounts(plan, session.sizes) : new Map<string, number>()),
    [plan, session.sizes],
  );

  // --- the problems ----------------------------------------------------------
  /**
   * The PAIRED designs whose ink artwork does not cover the product's ink
   * colours.
   *
   * This is the check that says WHAT is wrong. The partition check below
   * only knows that the product cannot be built ("132 variants are not in
   * any group"); this one knows that the design has no artwork for the ink
   * those colours need, which is the actual cause. A design whose "Ink
   * variants" box is unticked is never reported - it prints one artwork
   * everywhere by design.
   */
  const artworkProblems = React.useMemo(
    () =>
      inkArtworkProblems(
        // A paired design is never "missing" its ink artwork: its partner IS
        // the artwork for the other half.
        scope.filter((d) => !pairIds.includes(d.id)),
        productColourGroups(session),
        session.inkPairIds ?? [],
      ),
    [scope, session, pairIds],
  );

  /** How many of the batch's designs are affected. */
  const affectedDesigns = React.useMemo(
    () => new Set(artworkProblems.map((p) => p.designId)).size,
    [artworkProblems],
  );

  /**
   * The API-level problems: the partition is incomplete, the variant cap is
   * exceeded, or nothing matches the selection.
   *
   * These are the safety net. The ink artwork problems above are the ones
   * that say WHY a design cannot serve a colour.
   */
  const partitionProblems = React.useMemo(
    () => (plan ? studioPartitionProblems(plan, session) : []),
    [plan, session],
  );

  /**
   * Everything that stops the batch from being created.
   *
   * An undecided ink colour comes FIRST: it is the cause, and every other
   * complaint about a colour with no ink is only its symptom. Then the ink
   * artwork problems, which name the design. Then the EMPTY PANEL problems,
   * which name the design and the panel with no colours.
   */
  const problems = React.useMemo(
    () => [
      ...(plan ? undecidedInkProblems(plan) : []),
      ...artworkProblems.map((p) => `${p.designName}: ${describeMissingInk(p)}`),
      ...(plan ? emptyPanelProblems(plan) : []),
      ...partitionProblems,
    ],
    [artworkProblems, partitionProblems, plan],
  );

  /** Colours whose ink would be invisible on the garment. */
  const invisible = React.useMemo(
    () => inkProblems(session, hexFor).filter((p) => p.severity === "none"),
    [session, hexFor],
  );

  /** Designs that already have a product, so a retry must not duplicate it. */
  const alreadyCreated = React.useMemo(() => {
    const map = new Map<string, StudioProductResult>();
    for (const r of results) {
      if (r.status === "created" && r.remoteProductId) map.set(r.designId, r);
    }
    return map;
  }, [results]);

  const toCreate = React.useMemo(
    () => (plan ? plan.items.filter((i) => recreate || !alreadyCreated.has(i.designId)) : []),
    [plan, alreadyCreated, recreate],
  );

  // --- the design being adjusted ----------------------------------------------
  // The placement itself lives in the adjustment panel: it edits the same
  // session fields the listing reads, so what the user arranges is what gets
  // created. The tab only decides WHICH design the panel is for.
  const editingDesign = React.useMemo(
    () => (editingDesignId ? (designs ?? []).find((d) => d.id === editingDesignId) ?? null : null),
    [designs, editingDesignId],
  );

  /** The print area the edited design's placement points at. */
  const editingArea = React.useMemo(() => {
    if (!editingDesign) return area;
    const position = placementFor(session, editingDesign.id).position;
    return printAreas.find((a) => a.position === position) ?? area;
  }, [area, printAreas, session, editingDesign]);

  // --- creating --------------------------------------------------------------
  const createListings = async () => {
    if (!plan || !session.blueprintId || !session.printProviderId) return;
    if (problems.length > 0) {
      toast.error("Fix the problems above before creating the listings.");
      problemsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      problemsRef.current?.focus();
      return;
    }
    setCreating(true);
    const next: StudioProductResult[] = [];
    try {
      const outcome = await createStudioProducts(
        {
          session,
          plan,
          productName: productName(catalog, session.blueprintId),
          areaWidth: area?.width,
          areaHeight: area?.height,
        },
        toCreate,
        {
          onProgress: (item) => setProgress(item.designName),
          onResult: async (result) => {
            next.push(result);
            await persistResults([...next, ...results]);
          },
        },
      );
      const { created, failed } = outcome;
      toast.success(
        failed === 0
          ? `Created ${created.length} draft product${created.length === 1 ? "" : "s"} on Printify`
          : `Created ${created.length}, failed ${failed}`,
      );

      // The local listing drafts carry the copy, tags, price and selected
      // images. Save them now that the products they point at exist.
      if (created.length > 0) {
        try {
          await saveStudioListingDrafts({
            session,
            listings: buildStudioListings(designs ?? [], session),
            productName: productName(catalog, session.blueprintId),
            lockSelection: false,
          });
        } catch {
          // The products exist either way; the Listing details tab can save
          // the drafts again without touching Printify.
          toast.error("The products were created, but the local listing drafts could not be saved.");
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the listings");
    } finally {
      setCreating(false);
      setProgress("");
    }
  };

  return (
    <div className="space-y-5">
      {/* --- the designs ---------------------------------------------------- */}
      {/* Both rows are always shown, exactly as on the Designs page. */}
      {ROWS.map((row) => (
        <DesignGallery
          key={row}
          row={row}
          designs={galleryRows[row].map((g) => ({
            id: g.design.id,
            name: g.design.name,
            originalAssetId: g.design.originalAssetId,
            processedAssetId: g.design.processedAssetId,
            whiteInkAssetId: g.design.whiteInkAssetId,
            blackInkAssetId: g.design.blackInkAssetId,
            dimensions: g.dimensions,
          }))}
          swatches={swatchesForRow(row)}
          designColours={designColours}
          inkPairIds={session.inkPairIds ?? []}
          onToggleInkPair={toggleInkPair}
          pairInfo={pairInfo}
          onSetInkRole={setRole}
          onUnpair={unpair}
          onPairInk={pairTwo}
          onOpen={(id) => setEditingDesignId(id)}
        />
      ))}

      {/* Without a product there is no listing to create, but the designs and
          their placement are still there to look at. */}
      {!session.blueprintId ? (
        <EmptyState
          icon={<Package />}
          title="Choose a product first"
          description="Choose a product."
          actions={[{ label: "Go to Colors", onClick: onGoToColors }]}
        />
      ) : (
        <>
      {/* --- what will be created -------------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">
              Ready to create{" "}
              <span className="font-normal text-ink-muted">
                ({toCreate.length} product{toCreate.length === 1 ? "" : "s"})
              </span>
            </h2>
            <Badge variant="muted">
              {scope.length} of {designs?.length ?? 0} designs selected
            </Badge>
          </div>

          {scope.length === 0 && (
            <p className="text-xs text-ink-muted">
              No designs are ticked, so there is nothing to create. Tick the designs you want in the
              Designs tab.
            </p>
          )}

          <div ref={problemsRef} tabIndex={-1}>
            {artworkProblems.length > 0 && (
              <div role="alert" className="space-y-1 rounded-md bg-danger-soft px-3 py-2">
                {artworkProblems.map((p) => (
                  <p
                    key={`${p.designId}-${p.ink}`}
                    data-ink-problem=""
                    className="text-xs text-danger"
                  >
                    {p.designName}: {describeMissingInk(p)}
                  </p>
                ))}
              </div>
            )}
            {partitionProblems.length > 0 && (
              <div
                role="alert"
                className={`space-y-1 rounded-md bg-danger-soft px-3 py-2${
                  artworkProblems.length > 0 ? " mt-2" : ""
                }`}
              >
                {partitionProblems.slice(0, 5).map((p) => (
                  <p key={p} className="text-xs text-danger">
                    {p}
                  </p>
                ))}
                {partitionProblems.length > 5 && (
                  <p className="text-xs text-danger">…and {partitionProblems.length - 5} more.</p>
                )}
              </div>
            )}
            {affectedDesigns > 0 && (
              <p className="mt-2 text-xs text-danger">
                {affectedDesigns} of {scope.length} design{scope.length === 1 ? "" : "s"} cannot
                print every colour of this product with the ink artwork they have.
              </p>
            )}
            {invisible.length > 0 && (
              <div
                role="status"
                className="mt-2 flex items-start gap-1.5 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  The artwork will be invisible on{" "}
                  <strong>{invisible.map((p) => p.name).join(", ")}</strong> — the ink is the same
                  tone as the garment. Change the ink in the Colors tab if that is not intended.
                </span>
              </div>
            )}
          </div>

          {plan && plan.items.length > 0 && (
            <div className="scroll-thin max-h-[240px] space-y-1 overflow-y-auto">
              {plan.items.map((item) => {
                const done = alreadyCreated.get(item.designId);
                return (
                  <div
                    key={item.designId}
                    className="rounded-md bg-surface-muted/60 px-3 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs text-ink">
                        {item.designName}
                      </span>
                      <span className="text-xs text-ink-muted">
                        {item.groups
                          .filter((g) => g.colors.length > 0)
                          .map((g) => g.label)
                          .join(" + ")}
                      </span>
                      {done && !recreate && (
                        <Badge variant="muted">already created</Badge>
                      )}
                      <Badge variant="muted">{item.row === "ink" ? "ink" : "plain"}</Badge>
                    </div>
                    {/* Informational only: the counts say what THIS listing
                        prints - its own panel's colours, split by ink - and
                        the variant count is the enabled set with the chosen
                        sizes applied. */}
                    <p className="mt-0.5 text-xs text-ink-muted" data-colour-summary="">
                      {item.groups.filter((g) => g.colors.length > 0).length === 0
                        ? "no colours selected"
                        : item.groups
                            .filter((g) => g.colors.length > 0)
                            .map((g) => `${g.colors.length} ${g.label.toLowerCase()}`)
                            .join(" · ")}
                      {" · "}
                      {itemVariantCounts.get(item.designId) ?? 0} variants
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {plan && colourSummary.overlap.length > 0 && (
            <p className="text-xs text-ink-muted" data-colour-overlap="">
              {colourSummary.overlap.length} colour
              {colourSummary.overlap.length === 1 ? "" : "s"}{" "}
              {colourSummary.overlap.length === 1
                ? "is in both panels; that is fine, each row prints it with its own artwork."
                : "are in both panels; that is fine, each row prints them with its own artwork."}
            </p>
          )}

          <Separator />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-ink-muted">
              Products are created as <strong>drafts</strong>. Review them in Printify, then publish.
            </p>
            <div className="flex items-center gap-3">
              {alreadyCreated.size > 0 && (
                <label className="flex cursor-pointer items-center gap-2">
                  <Switch
                    checked={recreate}
                    onCheckedChange={setRecreate}
                    aria-label="Create again even for designs that already have a product"
                    id="studio-recreate"
                  />
                  <span className="text-xs text-ink">Recreate the {alreadyCreated.size} done</span>
                </label>
              )}
              <Button
                onClick={() => setConfirmOpen(true)}
                disabled={creating || !plan || toCreate.length === 0}
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {creating ? `Creating ${progress}…` : "Create on Printify"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* --- results ---------------------------------------------------------- */}
      {results.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <h2 className="text-sm font-semibold text-ink">Results</h2>
            <div className="space-y-1">
              {results
                .slice()
                .reverse()
                .slice(0, 50)
                .map((r, i) => (
                  <div key={`${r.designId}-${r.createdAt}-${i}`} className="flex items-center gap-2 text-xs">
                    <Badge
                      variant={r.status === "created" ? "forest" : r.status === "failed" ? "danger" : "muted"}
                    >
                      {r.status}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-ink" title={r.title}>
                      {r.title}
                    </span>
                    {r.remoteProductId && (
                      <a
                        href={`https://printify.com/app/products/${r.remoteProductId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-forest underline"
                      >
                        {r.remoteProductId}
                      </a>
                    )}
                    {r.error && <span className="text-xs text-danger">{r.error}</span>}
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}
        </>
      )}

      {/* --- the adjustment panel --------------------------------------------- */}
      {editingDesign && (
        <DesignAdjustmentPanel
          design={editingDesign}
          session={session}
          update={update}
          area={editingArea}
          printAreas={printAreas}
          onClose={() => setEditingDesignId(null)}
        />
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <Crosshair className="h-4 w-4" /> Create {toCreate.length} product
              {toCreate.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Each design becomes its own Printify product with the colours you picked. They are
              created as drafts, so nothing is published until you say so.
              {invisible.length > 0 && (
                <>
                  {" "}
                  <strong className="text-warning">
                    Note: the artwork will be invisible on {invisible.map((p) => p.name).join(", ")}.
                  </strong>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                void createListings();
              }}
            >
              Create drafts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function productName(catalog: StudioCatalogState, blueprintId?: number): string {
  return (
    catalog.blueprints.find((b) => b.id === blueprintId)?.title ??
    catalog.blueprints[0]?.title ??
    "Printify product"
  );
}
