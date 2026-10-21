"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import {
  createDesignFromFile,
  deleteDesign,
  designMainAssetId,
  getAssetBlob,
  logActivity,
  storeAsset,
} from "@/lib/db/repo";
import { removeBackground, type BgRemovalEngineId } from "@/lib/bg-removal/engine";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
import { WaveCompare } from "@/components/studio/wave-compare";
import { ColorSwatchRow } from "@/components/studio/color-swatch";
import { UploadDropzone } from "@/components/upload-dropzone";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/primitives";
import { Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { hexForColourName, suggestInk } from "@/lib/printify/colors";
import { ROW_HINTS, ROW_LABELS, ROWS } from "@/lib/printify/studio-session";
import type { StudioRowId, StudioSession } from "@/types/domain";
import { Images, Loader2, Trash2, Wand2 } from "lucide-react";

interface DesignRow {
  id: string;
  name: string;
  originalAssetId: string;
  processedAssetId?: string;
  whiteInkAssetId?: string;
  blackInkAssetId?: string;
  createdAt: number;
  dimensions: string;
}

interface DesignsTabProps {
  session: StudioSession;
  /** Update the session - the ticked designs ARE the batch scope. */
  update: (patch: Partial<StudioSession>) => void;
  /** The resolved swatches for a row, so each design shows its colours. */
  swatchesForRow: (row: StudioRowId) => Array<{ name: string; hex: string; ink?: "black" | "white" | "ambiguous" }>;
}

export function DesignsTab({ session, update, swatchesForRow }: DesignsTabProps) {
  const [uploading, setUploading] = React.useState(0);
  const [engine, setEngine] = React.useState<BgRemovalEngineId>("flood-key");
  const [tolerance, setTolerance] = React.useState(FLOOD_KEY_DEFAULTS.tolerance);
  const [busy, setBusy] = React.useState<{ done: number; total: number; current: string } | null>(null);
  const [paused, setPaused] = React.useState(false);

  /**
   * The ticked designs are the batch the Design panel will create. It lives
   * in the session so the other tab can see it - and so the scope survives a
   * reload instead of silently becoming "every design".
   */
  const selected = session.designIds;

  const setSelected = (ids: string[]) => update({ designIds: ids });

  const designs = useLiveQuery(async () => {
    const all = await db.designs.toArray();
    const metas = await db.assets.bulkGet(all.map((d) => d.originalAssetId));
    const metaMap = new Map(metas.filter(Boolean).map((m) => [m!.id, m!]));
    return all
      .map((d) => {
        const meta = metaMap.get(d.originalAssetId);
        return {
          id: d.id,
          name: d.name,
          originalAssetId: d.originalAssetId,
          processedAssetId: d.processedAssetId,
          whiteInkAssetId: d.whiteInkAssetId,
          blackInkAssetId: d.blackInkAssetId,
          createdAt: d.createdAt,
          dimensions: meta ? `${meta.width}×${meta.height}` : "—",
        } satisfies DesignRow;
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }, []);

  const rows = React.useMemo(() => {
    const plain: DesignRow[] = [];
    const ink: DesignRow[] = [];
    for (const d of designs ?? []) {
      if (d.whiteInkAssetId || d.blackInkAssetId) ink.push(d);
      else plain.push(d);
    }
    return { plain, ink } as Record<StudioRowId, DesignRow[]>;
  }, [designs]);

  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const handleFiles = async (files: File[]) => {
    let ok = 0;
    const errors: string[] = [];
    setUploading(files.length);
    for (const file of files) {
      const result = await createDesignFromFile(file);
      if (result.design) ok++;
      if (result.error) errors.push(result.error);
      setUploading((n) => n - 1);
    }
    if (ok > 0) toast.success(`Uploaded ${ok} design${ok > 1 ? "s" : ""}`);
    errors.slice(0, 3).forEach((e) => toast.error(e));
  };

  /**
   * Removes the background of every selected design, one at a time.
   *
   * The work is CPU-bound, so it is done sequentially with a yield between
   * designs: otherwise the progress bar never paints and the tab freezes.
   */
  const removeBackgrounds = async () => {
    if (selected.length === 0) return;
    const ids = [...selected];
    setBusy({ done: 0, total: ids.length, current: "" });
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      const design = await db.designs.get(id);
      if (!design) {
        done++;
        continue;
      }
      setBusy((b) => (b ? { ...b, current: design.name } : b));
      try {
        const sourceId = designMainAssetId(design);
        const blob = await getAssetBlob(sourceId);
        if (!blob) throw new Error(`Could not read "${design.name}" from storage`);
        const out = await removeBackground(engine, blob, tolerance);
        // `removed` is how much actually changed. The output's total
        // transparency cannot answer this: an artwork that was already
        // transparent scores 1.0 without a pixel being touched, and a
        // solid-colour artwork scores 1.0 because the ARTWORK was erased.
        if (out.removed < 0.005) {
          throw new Error(
            `"${design.name}": no background was detected. Try a higher tolerance, or the AI engine for photos.`,
          );
        }
        if (out.transparency > 0.999) {
          throw new Error(
            `"${design.name}": the whole image was removed - the artwork itself looked like the background. Try a lower tolerance.`,
          );
        }
        const asset = await storeAsset(out.blob, `${design.name}-cutout.png`, "design-processed", {
          parentId: design.originalAssetId,
        });
        await db.designs.update(design.id, {
          processedAssetId: asset.id,
          updatedAt: Date.now(),
        });
        await logActivity(
          "bgremoval.run",
          `Removed background from "${design.name}" (${Math.round(out.transparency * 100)}% transparent)`,
        );
      } catch (e) {
        failed++;
        toast.error(e instanceof Error ? e.message : `Could not process "${design.name}"`);
      }
      done++;
      setBusy({ done, total: ids.length, current: design.name });
      // Let the browser paint the progress bar.
      await new Promise((r) => setTimeout(r, 0));
    }
    setBusy(null);
    if (failed === 0) {
      toast.success(`Removed the background from ${done} design${done > 1 ? "s" : ""}`);
      setSelected([]);
    } else {
      toast.error(`${failed} of ${done} failed`);
    }
  };

  const removeSelected = async () => {
    if (selected.length === 0) return;
    for (const id of selected) await deleteDesign(id);
    toast.success(`Deleted ${selected.length} design${selected.length > 1 ? "s" : ""}`);
    setSelected([]);
  };

  const hasAny = (designs?.length ?? 0) > 0;

  return (
    <div className="space-y-5 pb-16">
      <div className="flex items-start gap-3">
        <UploadDropzone
          className="flex-1"
          label={
            uploading > 0
              ? `Processing ${uploading} file${uploading > 1 ? "s" : ""}…`
              : "Drop designs here, or click to browse"
          }
          hint="PNG, JPEG or WebP · up to 40 MB each · multiple files welcome"
          onFiles={handleFiles}
        />
        {hasAny && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPaused((p) => !p)}
            className="shrink-0"
          >
            {paused ? "Resume the wave" : "Pause the wave"}
          </Button>
        )}
      </div>

      {busy && (
        <div className="rounded-lg border border-border-subtle bg-surface px-4 py-3 shadow-card">
          <div className="flex items-center gap-2 text-[13px] text-ink">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="truncate">
              {busy.current ? `Removing background from "${busy.current}"` : "Working…"}
            </span>
            <span className="ml-auto text-ink-subtle">
              {busy.done} / {busy.total}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-forest transition-[width] duration-200"
              style={{ width: `${Math.round((busy.done / Math.max(1, busy.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {selected.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-forest/25 bg-sage-soft px-4 py-3 shadow-card">
          <span className="text-[13px] font-medium text-ink">
            {selected.length} design{selected.length > 1 ? "s" : ""} selected
          </span>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-[170px] space-y-1">
              <Label className="text-[11px] text-ink-muted">Engine</Label>
              <Select value={engine} onValueChange={(v) => setEngine(v as BgRemovalEngineId)}>
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="flood-key">Flood-key (solid backgrounds)</SelectItem>
                  <SelectItem value="ai-segmenter">AI segmentation (photos)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {engine === "flood-key" && (
              <div className="w-[120px] space-y-1">
                <Label className="text-[11px] text-ink-muted">Tolerance {tolerance}</Label>
                <input
                  type="range"
                  min={5}
                  max={120}
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                  className="h-8 w-full accent-[#314d3d]"
                />
              </div>
            )}
            <Button size="sm" onClick={removeBackgrounds} disabled={!!busy}>
              <Wand2 className="h-3.5 w-3.5" /> Remove background
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelected((designs ?? []).map((d) => d.id))}
            >
              Select all
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSelected([])}>
              Clear
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" onClick={removeSelected}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        </div>
      )}

      {!hasAny && (
        <EmptyState
          icon={<Images />}
          title="No designs yet"
          description="Upload your artwork above. Designs are split into two rows: those without ink variants, and those with them."
        />
      )}

      {ROWS.map((row) => {
        const list = rows[row];
        if (list.length === 0) return null;
        const swatches = swatchesForRow(row);
        return (
          <section key={row}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[14px] font-semibold text-ink">
                {ROW_LABELS[row]}{" "}
                <span className="font-normal text-ink-subtle">({list.length})</span>
              </h2>
              <p className="text-[11px] text-ink-muted">{ROW_HINTS[row]}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {list.map((d, i) => {
                const isSelected = selected.includes(d.id);
                return (
                  <Card
                    key={d.id}
                    className={cn(
                      "group relative overflow-hidden transition-shadow",
                      isSelected && "ring-2 ring-forest",
                    )}
                  >
                    <div className="relative">
                      <WaveCompare
                        originalAssetId={d.originalAssetId}
                        processedAssetId={d.processedAssetId}
                        index={i}
                        paused={paused}
                        className="aspect-square w-full"
                      />
                      <div className="absolute left-2 top-2">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggle(d.id)}
                          aria-label={`Select ${d.name}`}
                          // The artwork behind the box can be white, so the
                          // box needs its own edge to stay visible.
                          className="border-ink-subtle bg-white/90 shadow-subtle"
                        />
                      </div>
                      <div className="absolute right-2 top-2 flex gap-1">
                        {d.processedAssetId && <Badge>cutout</Badge>}
                        {d.whiteInkAssetId && <Badge>white ink</Badge>}
                        {d.blackInkAssetId && <Badge>black ink</Badge>}
                      </div>
                    </div>
                    <div className="space-y-1.5 border-t border-border-subtle px-3 py-2">
                      <div className="truncate text-[13px] font-medium text-ink" title={d.name}>
                        {d.name}
                      </div>
                      <div className="text-[11px] text-ink-subtle">{d.dimensions}</div>
                      {swatches.length > 0 && (
                        <ColorSwatchRow swatches={swatches} className="pt-0.5" />
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** The swatches a design's colours resolve to, used by the design cards. */
export function swatchesForColors(
  colors: string[],
  blackInkColors: string[],
  hasInkVariants: boolean,
): Array<{ name: string; hex: string; ink?: "black" | "white" | "ambiguous" }> {
  return colors.map((name) => {
    const hex = hexForColourName(name);
    if (!hasInkVariants) return { name, hex };
    const ink = blackInkColors.includes(name) ? "black" : "white";
    return { name, hex, ink };
  });
}

/** The ink a colour would use by default, from the colour's own lightness. */
export function autoInkForColor(name: string): "black" | "white" | "ambiguous" {
  return suggestInk(hexForColourName(name));
}
