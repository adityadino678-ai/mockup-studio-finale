"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db, getSetting, setSetting } from "@/lib/db/schema";
import { designMainAssetId, getAssetBlob, logActivity, uid } from "@/lib/db/repo";
import { authedFetch } from "@/lib/client/integrations";
import { artworkToBase64Sized } from "@/lib/client/artwork";
import { decodeImage } from "@/lib/image/image";
import { PrintAreaPreview } from "@/components/studio/print-area-preview";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, Separator } from "@/components/ui/card";
import { FieldLabel, Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildPartition, inkGroupsForDesign, resolveVariantIds } from "@/lib/printify/variants";
import { assertCompletePartition } from "@/lib/printify/print-areas";
import { clampPlacement } from "@/lib/printify/fit";
import { inkProblems, placementFor, renderTitle, RESULTS_KEY } from "@/lib/printify/studio-session";
import type { StudioCatalogState } from "@/views/printify-studio-page";
import type { StudioPlacement, StudioProductResult, StudioSession } from "@/types/domain";
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

export function PlacementTab({ session, update, catalog, hexFor, onGoToColors }: PlacementTabProps) {
  const [results, setResults] = React.useState<StudioProductResult[]>([]);
  const [creating, setCreating] = React.useState(false);
  const [progress, setProgress] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [recreate, setRecreate] = React.useState(false);
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewSize, setPreviewSize] = React.useState({ w: 0, h: 0 });
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const problemsRef = React.useRef<HTMLDivElement | null>(null);

  const designs = useLiveQuery(() => db.designs.toArray(), []);

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
  const plan = React.useMemo(() => {
    if (!designs || !session.blueprintId || !session.printProviderId) return null;
    const colourIndex = buildIndexFromVariants(catalog.variants);
    const items: DesignPlan[] = [];
    for (const design of scope) {
      const row: "plain" | "ink" = design.whiteInkAssetId || design.blackInkAssetId ? "ink" : "plain";
      const state = session.rows[row];
      const groups = inkGroupsForDesign({
        hasInkVariants: row === "ink",
        selectedColors: state?.colors ?? [],
        blackInkColors: session.rows.ink?.blackInkColors ?? [],
      });
      items.push({
        designId: design.id,
        designName: design.name,
        row,
        groups: groups.map((g) => {
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
  const problems = React.useMemo(() => {
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

  // --- the preview -----------------------------------------------------------
  const previewDesign = React.useMemo(() => {
    if (!designs || designs.length === 0) return null;
    if (previewId) return designs.find((d) => d.id === previewId) ?? designs[0];
    return designs[0];
  }, [designs, previewId]);

  React.useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      if (!previewDesign) {
        setPreviewUrl(null);
        return;
      }
      const blob = await getAssetBlob(designMainAssetId(previewDesign));
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      try {
        const bmp = await decodeImage(blob);
        if (cancelled) {
          bmp.close();
          return;
        }
        setPreviewSize({ w: bmp.width, h: bmp.height });
        bmp.close();
      } catch {
        setPreviewSize({ w: 0, h: 0 });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [previewDesign]);

  // --- the placement being edited --------------------------------------------
  // With "one placement for every design" on, the controls edit the shared
  // placement. With it off, they edit the design picked below.
  const editingPlacement: StudioPlacement = React.useMemo(() => {
    if (session.universal || !editingId) return session.universalPlacement;
    return session.placements[editingId] ?? session.universalPlacement;
  }, [session.universal, session.universalPlacement, session.placements, editingId]);

  const setEditingPlacement = (patch: Partial<StudioPlacement>) => {
    const merged = { ...editingPlacement, ...patch };
    // Rounded on write: a drag produces raw floats like 0.5045991124897677,
    // which is not a value the number inputs can show or accept.
    const next: StudioPlacement = {
      position: merged.position,
      x: Math.round(merged.x * 1000) / 1000,
      y: Math.round(merged.y * 1000) / 1000,
      scale: Math.round(merged.scale * 1000) / 1000,
      angle: Math.round(merged.angle * 10) / 10,
    };
    if (session.universal || !editingId) {
      update({ universalPlacement: next });
      return;
    }
    update({ placements: { ...session.placements, [editingId]: next } });
  };

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

  if (!session.blueprintId) {
    return (
      <EmptyState
        icon={<Package />}
        title="Choose a product first"
        description="The design panel needs a product, because the print area and its size come from the product's placeholders."
        actions={[{ label: "Go to Colors", onClick: onGoToColors }]}
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* --- placement ------------------------------------------------------ */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold text-ink">Where the artwork sits</h2>
              <p className="text-[11px] text-ink-muted">
                Printify positions artwork from the centre of the print area.
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
                checked={session.universal}
                onCheckedChange={(v) => update({ universal: v })}
                aria-label="Use one placement for every design"
                id="studio-universal"
              />
              <span className="text-[12px] text-ink">One placement for every design</span>
            </label>
          </div>

          {!session.universal && (
            <div className="space-y-1.5 rounded-md bg-surface-muted/60 p-3">
              <FieldLabel htmlFor="studio-edit-design">Editing the placement of</FieldLabel>
              <select
                id="studio-edit-design"
                value={editingId ?? ""}
                onChange={(e) => setEditingId(e.target.value || null)}
                className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink"
              >
                <option value="">Pick a design…</option>
                {scope.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-ink-subtle">
                Every design starts from the shared placement; pick one above to adjust it on its
                own.
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-[260px_1fr]">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <FieldLabel htmlFor="studio-print-area">Print area</FieldLabel>
                <div id="studio-print-area" className="flex flex-wrap gap-1.5">
                  {printAreas.map((a) => (
                    <Button
                      key={a.position}
                      size="sm"
                      variant={editingPlacement.position === a.position ? "default" : "outline"}
                      onClick={() => setEditingPlacement({ position: a.position })}
                      className="h-7 text-[12px]"
                    >
                      {a.position}
                    </Button>
                  ))}
                </div>
                {area && (
                  <p className="text-[11px] text-ink-subtle">
                    {area.width} × {area.height} px
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <FieldLabel htmlFor="studio-scale">
                  Width ({Math.round(editingPlacement.scale * 100)}% of the area)
                </FieldLabel>
                <input
                  id="studio-scale"
                  type="range"
                  min={5}
                  max={100}
                  value={Math.round(editingPlacement.scale * 100)}
                  onChange={(e) => setEditingPlacement({ scale: Number(e.target.value) / 100 })}
                  className="h-8 w-full accent-[#314d3d]"
                />
              </div>

              <div className="space-y-1.5">
                <FieldLabel htmlFor="studio-angle">
                  Rotation ({Math.round(editingPlacement.angle)}°)
                </FieldLabel>
                <input
                  id="studio-angle"
                  type="range"
                  min={-180}
                  max={180}
                  value={editingPlacement.angle}
                  onChange={(e) => setEditingPlacement({ angle: Number(e.target.value) })}
                  className="h-8 w-full accent-[#314d3d]"
                />
              </div>

              <div className="flex gap-2">
                <div className="w-1/2 space-y-1.5">
                  <FieldLabel htmlFor="studio-x">Centre X</FieldLabel>
                  <Input
                    id="studio-x"
                    type="number"
                    step={0.01}
                    min={0}
                    max={1}
                    value={editingPlacement.x}
                    onChange={(e) => setEditingPlacement({ x: Number(e.target.value) })}
                    className="h-8 text-[12px]"
                  />
                </div>
                <div className="w-1/2 space-y-1.5">
                  <FieldLabel htmlFor="studio-y">Centre Y</FieldLabel>
                  <Input
                    id="studio-y"
                    type="number"
                    step={0.01}
                    min={0}
                    max={1}
                    value={editingPlacement.y}
                    onChange={(e) => setEditingPlacement({ y: Number(e.target.value) })}
                    className="h-8 text-[12px]"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <PrintAreaPreview
                artworkUrl={previewUrl}
                artworkWidth={previewSize.w}
                artworkHeight={previewSize.h}
                areaWidth={area?.width ?? 3000}
                areaHeight={area?.height ?? 3000}
                placement={editingPlacement}
                onChange={setEditingPlacement}
                className="mx-auto max-w-[320px]"
              />
              <p className="text-[11px] leading-relaxed text-ink-subtle">
                Drag the artwork to move it. The dashed frame is the print area; Printify does not
                publish where that frame sits on the garment, so the position on the shirt itself is
                an approximation.
              </p>
              {designs && designs.length > 1 && (
                <div className="space-y-1.5">
                  <FieldLabel htmlFor="studio-preview">Previewing</FieldLabel>
                  <select
                    id="studio-preview"
                    value={previewDesign?.id ?? ""}
                    onChange={(e) => setPreviewId(e.target.value || null)}
                    className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink"
                  >
                    {designs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

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
            {problems.length > 0 && (
              <div role="alert" className="space-y-1 rounded-md bg-danger-soft px-3 py-2">
                {problems.slice(0, 5).map((p) => (
                  <p key={p} className="text-[12px] text-danger">
                    {p}
                  </p>
                ))}
                {problems.length > 5 && (
                  <p className="text-[12px] text-danger">…and {problems.length - 5} more.</p>
                )}
              </div>
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
