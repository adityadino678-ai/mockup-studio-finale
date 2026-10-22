"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db, getSetting, setSetting } from "@/lib/db/schema";
import { designMainAssetId, getAssetBlob, logActivity, uid } from "@/lib/db/repo";
import { authedFetch } from "@/lib/client/integrations";
import { artworkToBase64Sized } from "@/lib/client/artwork";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, Separator } from "@/components/ui/card";
import { FieldLabel, Input } from "@/components/ui/input";
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
import { buildPartition, resolveVariantIds } from "@/lib/printify/variants";
import {
  coloursToMoveToPlain,
  inkArtworkProblems,
  planDesignColours,
  type InkArtworkProblem,
} from "@/lib/printify/design-colours";
import { assertCompletePartition } from "@/lib/printify/print-areas";
import { clampPlacement } from "@/lib/printify/fit";
import { inkProblems, placementFor, renderTitle, RESULTS_KEY, ROWS } from "@/lib/printify/studio-session";
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

/** Printify's own limit on enabled variants per product. */
const MAX_VARIANTS = 100;

/** One artwork group of a design: which ink, which file, which colours. */
interface DesignGroup {
  ink: "main" | "black" | "white";
  assetId: string;
  colors: string[];
  label: string;
  /** True when the design has no ink file and the main design is used. */
  fallback: boolean;
}

interface DesignPlan {
  designId: string;
  designName: string;
  row: "plain" | "ink";
  groups: DesignGroup[];
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

  /**
   * The gallery split into the two rows, for the ONE selected product.
   *
   * The split follows the product, not the design: a design is in the ink
   * row only when its ink artwork is one this product's colours need. So a
   * product with an empty ink group puts EVERY design in the "no ink
   * variants" row, and the Design panel agrees with the Designs tab because
   * both call the same helper.
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
   * The card cannot show its row's colours any more: a design without ink
   * artwork prints on the plain AND the ink colours with its main artwork,
   * and a design with ink artwork prints on the plain ones with its main
   * artwork and on the ink ones with its ink artwork.
   */
  const designColours = React.useCallback(
    (design: DesignCardData): DesignColours => {
      const plan = planDesignColours(
        {
          hasBlackInk: Boolean(design.blackInkAssetId),
          hasWhiteInk: Boolean(design.whiteInkAssetId),
        },
        productColourGroups(session),
      );
      return { colors: plan.colors, swatches: swatchesForPlan(plan, hexFor) };
    },
    [session, hexFor],
  );

  /** The colour swatches of a row, so every card in it shows its colours. */
  const swatchesForRow = React.useCallback(
    (row: "plain" | "ink"): DesignSwatch[] =>
      (session.rows[row]?.colors ?? []).map((name) => {
        const hex = hexFor(name);
        if (row === "plain") return { name, hex };
        const ink = session.rows.ink?.blackInkColors?.includes(name)
          ? ("black" as const)
          : ("white" as const);
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
   * The plan comes from the product's colour groups and the design's own ink
   * artwork, so it always covers EVERY colour of the product: the plain ones
   * with the main artwork, the ink ones with the ink artwork the design
   * actually has. A design with no ink artwork prints its main artwork
   * everywhere - that is reported as a problem, never dropped silently.
   */
  const plan = React.useMemo(() => {
    if (!designs || !session.blueprintId || !session.printProviderId) return null;
    const colourIndex = buildIndexFromVariants(catalog.variants);
    const groups = productColourGroups(session);
    const items: DesignPlan[] = [];
    for (const design of scope) {
      const colourPlan = planDesignColours(
        {
          hasBlackInk: Boolean(design.blackInkAssetId),
          hasWhiteInk: Boolean(design.whiteInkAssetId),
        },
        groups,
      );
      items.push({
        designId: design.id,
        designName: design.name,
        row: colourPlan.usesInkArtwork ? "ink" : "plain",
        groups: colourPlan.groups.map((g) => {
          if (g.ink === "main") {
            return {
              ink: g.ink,
              assetId: designMainAssetId(design),
              colors: g.colors,
              label: "Main design",
              fallback: false,
            };
          }
          const own = g.ink === "black" ? design.blackInkAssetId : design.whiteInkAssetId;
          return {
            ink: g.ink,
            assetId: own ?? designMainAssetId(design),
            colors: g.colors,
            label: own
              ? g.ink === "black"
                ? "Black ink"
                : "White ink"
              : `${g.ink === "black" ? "Black" : "White"} ink (using the main design)`,
            fallback: !own,
          };
        }),
      });
    }
    return { items, colourIndex };
  }, [designs, scope, session, catalog.variants]);

  // --- the problems ----------------------------------------------------------
  /**
   * The designs whose ink artwork does not cover the product's ink colours.
   *
   * This is the check that says WHAT is wrong. The partition check below
   * only knows that the product cannot be built ("132 variants are not in
   * any group"); this one knows that the design has no artwork for the ink
   * those colours need, which is the actual cause.
   */
  const artworkProblems = React.useMemo(
    () => inkArtworkProblems(scope, productColourGroups(session)),
    [scope, session],
  );

  /** The colours the one-click fix would move into the one-artwork group. */
  const movable = React.useMemo(() => coloursToMoveToPlain(artworkProblems), [artworkProblems]);

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
  const partitionProblems = React.useMemo(() => {
    if (!plan) return [];
    const found: string[] = [];
    for (const item of plan.items) {
      const partition = buildPartition(
        plan.colourIndex,
        item.groups.map((g) => ({ ink: g.ink, colors: g.colors })),
      );
      const issues = assertCompletePartition(
        partition.groups.map((g, i) => ({
          imageId: item.groups[i]?.assetId ?? "",
          variantIds: g.variantIds,
          colors: g.colors,
        })),
        plan.colourIndex.allVariantIds,
      );
      for (const issue of issues) found.push(`${item.designName}: ${issue.detail}`);

      // The cap applies to the ENABLED variants of each product.
      const enabled = resolveVariantIds(
        plan.colourIndex,
        item.groups.flatMap((g) => g.colors),
        session.sizes,
      );
      if (enabled.length > MAX_VARIANTS) {
        found.push(
          `${item.designName}: ${enabled.length} variants - Printify allows at most ${MAX_VARIANTS} per product.`,
        );
      }
      if (enabled.length === 0) {
        found.push(`${item.designName}: no variants match the selected colours and sizes.`);
      }
    }
    return found;
  }, [plan, session.sizes]);

  /**
   * Everything that stops the batch from being created.
   *
   * The ink artwork problems come first: they name the cause, and they are
   * the ones the one-click fix clears.
   */
  const problems = React.useMemo(
    () => [
      ...artworkProblems.map((p) => `${p.designName}: ${describeMissingInk(p)}`),
      ...partitionProblems,
    ],
    [artworkProblems, partitionProblems],
  );

  /**
   * Moves the colours no design can serve into the one-artwork group.
   *
   * The colours are exactly the ones the problems name, so after the move
   * every design can print every colour of the product with its main
   * artwork and the problem is gone. The rows are copied, never mutated:
   * the session is React state, and a mutated object would not re-render.
   */
  const moveColoursToPlain = React.useCallback(() => {
    if (movable.length === 0) return;
    const moving = new Set(movable);
    const rows = { ...session.rows };
    const plainColors = [...(rows.plain?.colors ?? [])];
    const inkColors = (rows.ink?.colors ?? []).filter((c) => !moving.has(c));
    for (const colour of movable) {
      if (!plainColors.includes(colour)) plainColors.push(colour);
    }
    rows.plain = {
      colors: plainColors,
      blackInkColors: (rows.plain?.blackInkColors ?? []).filter((c) => plainColors.includes(c)),
    };
    rows.ink = {
      colors: inkColors,
      blackInkColors: (rows.ink?.blackInkColors ?? []).filter((c) => inkColors.includes(c)),
    };
    update({ rows });
    toast.success(
      `Moved ${movable.length} colour${movable.length === 1 ? "" : "s"} to the one-artwork group. Every design can print every colour now.`,
    );
  }, [movable, session.rows, update]);

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
    const created: StudioProductResult[] = [];
    let failed = 0;
    try {
      for (const item of toCreate) {
        setProgress(item.designName);
        const partition = buildPartition(
          plan.colourIndex,
          item.groups.map((g) => ({ ink: g.ink, colors: g.colors })),
        );
        const enabled = resolveVariantIds(
          plan.colourIndex,
          item.groups.flatMap((g) => g.colors),
          session.sizes,
        );
        if (enabled.length === 0) {
          next.push({
            designId: item.designId,
            title: item.designName,
            designName: item.designName,
            status: "skipped",
            error: "No variants selected for this design's colours.",
            createdAt: Date.now(),
          });
          continue;
        }

        // One upload per ink group, sized to the print area so the print is
        // sharp and Printify's resolution check passes.
        const artworks: Array<{
          printAreaId: string;
          variantIds: number[];
          base64: string;
          filename: string;
          placement: { x: number; y: number; scale: number; angle: number };
        }> = [];
        for (let i = 0; i < partition.groups.length; i++) {
          const group = partition.groups[i];
          const artwork = item.groups[i];
          if (!artwork || group.variantIds.length === 0) continue;
          const blob = await getAssetBlob(artwork.assetId);
          if (!blob) throw new Error(`Could not read "${item.designName}" from storage`);
          const longEdge = Math.max(area?.width ?? 3000, area?.height ?? 3000);
          const base64 = await artworkToBase64Sized(blob, longEdge);
          const p = placementFor(session, item.designId);
          const clamped = clampPlacement(p);
          artworks.push({
            printAreaId: p.position,
            variantIds: group.variantIds,
            base64,
            filename: `${item.designName}-${artwork.ink}.png`,
            placement: clamped,
          });
        }

        const title = renderTitle(
          session.titleTemplate,
          item.designName,
          productName(catalog, session.blueprintId),
        );
        const res = await authedFetch("/api/printify/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirm: true,
            title,
            description: "",
            blueprintId: session.blueprintId,
            printProviderId: session.printProviderId,
            variants: { [String(session.blueprintId)]: enabled },
            price: session.priceCents ?? 1999,
            artworks,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          failed++;
          next.push({
            designId: item.designId,
            title,
            designName: item.designName,
            status: "failed",
            error: data.error ?? `HTTP ${res.status}`,
            createdAt: Date.now(),
          });
          await persistResults([...next, ...results]);
          continue;
        }

        // Verify the product Printify actually built: every enabled variant
        // must sit in the group whose artwork we uploaded for it. The create
        // response carries the whole product, so this costs no extra calls.
        const product = data.product ?? {};
        const uploaded = new Map<string, string>();
        for (const a of data.artworks ?? []) uploaded.set(a.variantIds.join(","), a.imageId);
        const imageByVariant = new Map<number, string>();
        for (const areaEntry of product.print_areas ?? []) {
          for (const ph of areaEntry.placeholders ?? []) {
            for (const img of ph.images ?? []) {
              for (const vid of areaEntry.variant_ids ?? []) {
                if (!imageByVariant.has(vid)) imageByVariant.set(vid, img.id);
              }
            }
          }
        }
        const expectedImageFor = (variantId: number): string | undefined => {
          for (let i = 0; i < partition.groups.length; i++) {
            if (partition.groups[i].variantIds.includes(variantId)) return item.groups[i]?.assetId;
          }
          return undefined;
        };
        const wrongArtwork: string[] = [];
        for (const v of product.variants ?? []) {
          if (!v.is_enabled) continue;
          const got = imageByVariant.get(v.id);
          const want = expectedImageFor(v.id);
          if (got && want && got !== want) wrongArtwork.push(String(v.id));
        }
        if (wrongArtwork.length > 0) {
          failed++;
          next.push({
            designId: item.designId,
            title,
            designName: item.designName,
            status: "failed",
            remoteProductId: product.id,
            error: `Printify attached the wrong artwork to ${wrongArtwork.length} variant(s). Check the print areas before publishing.`,
            createdAt: Date.now(),
          });
          await persistResults([...next, ...results]);
          continue;
        }

        // Record the product in the app's own draft table, so it shows up in
        // the Product Builder, the Listings page and the artifact rail.
        const mainAsset = item.groups[0]?.assetId ?? "";
        await db.productDrafts.put({
          id: uid(),
          name: title,
          designId: item.designId,
          designAssetId: mainAsset,
          blueprintId: session.blueprintId,
          printProviderId: session.printProviderId,
          priceCents: session.priceCents,
          variantSelection: {},
          printAreaConfig: {},
          status: "created-remote",
          remoteProductId: product.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const record: StudioProductResult = {
          designId: item.designId,
          title,
          designName: item.designName,
          status: "created",
          remoteProductId: product.id,
          createdAt: Date.now(),
        };
        next.push(record);
        created.push(record);
        await persistResults([...next, ...results]);
        await logActivity("product.create", `Created Printify product "${title}" (${product.id})`, {
          productId: product.id,
          designId: item.designId,
        });
      }
      toast.success(
        failed === 0
          ? `Created ${created.length} draft product${created.length === 1 ? "" : "s"} on Printify`
          : `Created ${created.length}, failed ${failed}`,
      );
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
          indexOffset={row === "ink" ? galleryRows.plain.length : 0}
          onOpen={(id) => setEditingDesignId(id)}
        />
      ))}

      {/* Without a product there is no listing to create, but the designs and
          their placement are still there to look at. */}
      {!session.blueprintId ? (
        <EmptyState
          icon={<Package />}
          title="Choose a product first"
          description="The design panel needs a product, because the print area and its size come from the product's placeholders."
          actions={[{ label: "Go to Colors", onClick: onGoToColors }]}
        />
      ) : (
        <>
      {/* --- listing details ------------------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-[14px] font-semibold text-ink">Listing details</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="studio-title">Title</FieldLabel>
              <Input
                id="studio-title"
                value={session.titleTemplate ?? ""}
                onChange={(e) => update({ titleTemplate: e.target.value })}
                placeholder="{design} — {product}"
                className="h-8 text-[12px]"
              />
              <p className="text-[11px] text-ink-subtle">
                {"{design}"} is the file name, {"{product}"} the product title.
              </p>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="studio-price">Price (USD)</FieldLabel>
              <Input
                id="studio-price"
                type="number"
                min={0.5}
                step={0.01}
                value={((session.priceCents ?? 1999) / 100).toFixed(2)}
                onChange={(e) =>
                  update({ priceCents: Math.round(Number(e.target.value) * 100) || undefined })
                }
                className="h-8 text-[12px]"
              />
              <p className="text-[11px] text-ink-subtle">Printify needs a price on every variant.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* --- what will be created -------------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-ink">
              Ready to create{" "}
              <span className="font-normal text-ink-subtle">
                ({toCreate.length} product{toCreate.length === 1 ? "" : "s"})
              </span>
            </h2>
            <Badge variant="muted">
              {scope.length} of {designs?.length ?? 0} designs selected
            </Badge>
          </div>

          {scope.length === 0 && (
            <p className="text-[12px] text-ink-muted">
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
                    className="text-[12px] text-danger"
                  >
                    {p.designName}: {describeMissingInk(p)}
                  </p>
                ))}
                {movable.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={moveColoursToPlain}
                      title="After the move every design can print every colour with the main artwork, so the problem disappears."
                      data-move-to-plain=""
                    >
                      Move these colours to the one-artwork group
                    </Button>
                    <span className="text-[11px] text-danger">
                      {movable.join(", ")} will print with the main artwork, so every design can
                      print every colour.
                    </span>
                  </div>
                )}
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
                  <p key={p} className="text-[12px] text-danger">
                    {p}
                  </p>
                ))}
                {partitionProblems.length > 5 && (
                  <p className="text-[12px] text-danger">…and {partitionProblems.length - 5} more.</p>
                )}
              </div>
            )}
            {affectedDesigns > 0 && (
              <p className="mt-2 text-[12px] text-danger">
                {affectedDesigns} of {scope.length} design{scope.length === 1 ? "" : "s"} cannot
                print every colour of this product with the ink artwork they have.
              </p>
            )}
            {invisible.length > 0 && (
              <div
                role="status"
                className="mt-2 flex items-start gap-1.5 rounded-md bg-warning-soft px-3 py-2 text-[12px] text-warning"
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
            <div className="scroll-thin max-h-[220px] space-y-1 overflow-y-auto">
              {plan.items.map((item) => {
                const done = alreadyCreated.get(item.designId);
                return (
                  <div
                    key={item.designId}
                    className="flex items-center gap-2 rounded-md bg-surface-muted/60 px-3 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                      {item.designName}
                    </span>
                    <span className="text-[11px] text-ink-subtle">
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
                );
              })}
            </div>
          )}

          <Separator />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-ink-muted">
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
                  <span className="text-[12px] text-ink">Recreate the {alreadyCreated.size} done</span>
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
            <h2 className="text-[14px] font-semibold text-ink">Results</h2>
            <div className="space-y-1">
              {results
                .slice()
                .reverse()
                .slice(0, 50)
                .map((r, i) => (
                  <div key={`${r.designId}-${r.createdAt}-${i}`} className="flex items-center gap-2 text-[12px]">
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
                        href={`https://www.printify.com/app/products/${r.remoteProductId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[11px] text-forest underline"
                      >
                        {r.remoteProductId}
                      </a>
                    )}
                    {r.error && <span className="text-[11px] text-danger">{r.error}</span>}
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

/**
 * What is actually wrong with one design and one ink.
 *
 * The wording names the colour, the artwork that is missing and the
 * consequence, because the partition check that used to catch this said
 * none of that - it only said that the product could not be built.
 */
function describeMissingInk(problem: InkArtworkProblem): string {
  const colours = joinNames(problem.colors);
  if (problem.ink === "white") {
    return `this design has no white-ink artwork, so on ${colours} it would print with the main artwork - invisible on a dark garment.`;
  }
  return `this design has no black-ink artwork, so on ${colours} it would print with the main artwork - it was not prepared for the black ink.`;
}

/** "Black", "Black and Navy", "Black, Navy and White". */
function joinNames(names: string[]): string {
  if (names.length === 0) return "the ink colours";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Builds the colour index from the catalogue variants. */
function buildIndexFromVariants(variants: StudioCatalogState["variants"]) {
  const valueIds = new Map<string, number>();
  const hexes = new Map<string, string[]>();
  const variantIds = new Map<string, number[]>();
  const sizes = new Map<string, number[]>();
  const allVariantIds: number[] = [];
  for (const v of variants) {
    allVariantIds.push(v.id);
    const colour = v.options?.color ?? v.title?.split(" / ")[0] ?? "unknown";
    const size = v.options?.size ?? v.title?.split(" / ")[1] ?? "";
    if (!variantIds.has(colour)) variantIds.set(colour, []);
    variantIds.get(colour)!.push(v.id);
    if (size) {
      if (!sizes.has(size)) sizes.set(size, []);
      sizes.get(size)!.push(v.id);
    }
  }
  return { valueIds, hexes, variantIds, sizes, allVariantIds };
}

function productName(catalog: StudioCatalogState, blueprintId?: number): string {
  return (
    catalog.blueprints.find((b) => b.id === blueprintId)?.title ??
    catalog.blueprints[0]?.title ??
    "Printify product"
  );
}
