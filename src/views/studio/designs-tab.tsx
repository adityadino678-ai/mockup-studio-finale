"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import {
  createDesignFromFile,
  deleteDesign,
  getAssetBlob,
  logActivity,
  storeAsset,
} from "@/lib/db/repo";
import { removeBackgroundAuto, type RemoveEngine } from "@/lib/printify/remove-background";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
import { planDesignColours } from "@/lib/printify/design-colours";
import {
  DesignGallery,
  productColourGroups,
  splitDesignsForSession,
  swatchesForPlan,
  type DesignColours,
  type DesignSwatch,
} from "@/views/studio/design-panel";
import type { DesignCardData } from "@/components/studio/design-card";
import { UploadDropzone } from "@/components/upload-dropzone";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/primitives";
import { Label } from "@/components/ui/input";
import { hexForColourName, suggestInk } from "@/lib/printify/colors";
import { ROWS } from "@/lib/printify/studio-session";
import type { Design, StudioRowId, StudioSession } from "@/types/domain";
import { Loader2, Trash2, Wand2 } from "lucide-react";

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
  swatchesForRow: (row: StudioRowId) => DesignSwatch[];
}

/**
 * How long a stage of the work stays on screen.
 *
 * The engine reports its stages as it works and two of them can arrive
 * within the same frame. The message that explains the ~25 MB model download
 * would then be replaced before it was ever painted, which is exactly the
 * silent freeze that message exists to prevent. So every stage stays up for
 * a moment and the next one waits its turn.
 */
const MIN_STAGE_MS = 900;

export function DesignsTab({ session, update, swatchesForRow }: DesignsTabProps) {
  const [uploading, setUploading] = React.useState(0);
  const [engine, setEngine] = React.useState<RemoveEngine>("auto");
  const [tolerance, setTolerance] = React.useState(FLOOD_KEY_DEFAULTS.tolerance);
  const [busy, setBusy] = React.useState<{
    done: number;
    total: number;
    current: string;
  } | null>(null);
  /** The stage of the work, as the engine reports it. */
  const [stage, setStage] = React.useState("");
  const stageQueue = React.useRef<string[]>([]);
  const stageShownAt = React.useRef(0);
  const stageTimer = React.useRef<number | null>(null);
  const [paused, setPaused] = React.useState(false);

  /**
   * Shows a stage of the work and keeps it up long enough to read it.
   *
   * The stages are queued rather than replaced: one that arrives while
   * another is on screen waits for its turn, so the message that explains a
   * slow step is never swallowed by the step that follows it.
   */
  const showStage = React.useCallback((next: string) => {
    stageQueue.current.push(next);
    if (stageTimer.current !== null) return;
    const wait = Math.max(0, MIN_STAGE_MS - (Date.now() - stageShownAt.current));
    const pump = () => {
      const pending = stageQueue.current.shift();
      if (pending === undefined) {
        stageTimer.current = null;
        return;
      }
      setStage(pending);
      stageShownAt.current = Date.now();
      if (stageQueue.current.length > 0) {
        stageTimer.current = window.setTimeout(pump, MIN_STAGE_MS);
      } else {
        stageTimer.current = null;
      }
    };
    if (wait === 0) {
      pump();
    } else {
      stageTimer.current = window.setTimeout(pump, wait);
    }
  }, []);

  /** Throws the queued stages away - the run they belonged to is over. */
  const resetStages = React.useCallback(() => {
    if (stageTimer.current !== null) {
      window.clearTimeout(stageTimer.current);
      stageTimer.current = null;
    }
    stageQueue.current = [];
    stageShownAt.current = 0;
    setStage("");
  }, []);

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

  /**
   * The gallery split into the two rows, for the ONE selected product.
   *
   * The split is a property of (product, design), not of the design alone:
   * a design belongs with the ink colours only when its ink artwork is one
   * THIS product actually needs. So a product with an empty ink group needs
   * no ink artwork at all, and every design is a "no ink variants" design
   * for it - even one that has an ink variant on file.
   */
  const rows = React.useMemo(() => {
    const split = splitDesignsForSession(designs ?? [], session);
    return { plain: split.plain, ink: split.ink } as Record<StudioRowId, DesignRow[]>;
  }, [designs, session]);

  /**
   * The hex of every colour of the product.
   *
   * The swatches come from the page, which knows the real hexes of the
   * product; this map lets a design find the hex of a colour it prints on
   * whichever row that colour happens to live in.
   */
  const hexByColour = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const row of ROWS) {
      for (const swatch of swatchesForRow(row)) map.set(swatch.name, swatch.hex);
    }
    return map;
  }, [swatchesForRow]);

  /**
   * What each design prints on, for its card.
   *
   * A design without ink artwork prints its MAIN artwork on every colour of
   * the product; a design with ink artwork prints its main artwork on the
   * plain colours and its ink artwork on the ink ones. The card says so,
   * so the user can see which colours each design will be printed on.
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
      const hexFor = (name: string) => hexByColour.get(name) ?? hexForColourName(name);
      return { colors: plan.colors, swatches: swatchesForPlan(plan, hexFor) };
    },
    [session, hexByColour],
  );

  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const handleFiles = async (files: File[]) => {
    let ok = 0;
    const errors: string[] = [];
    const uploaded: Design[] = [];
    setUploading(files.length);
    for (const file of files) {
      const result = await createDesignFromFile(file);
      if (result.design) {
        ok++;
        uploaded.push(result.design);
      }
      if (result.error) errors.push(result.error);
      setUploading((n) => n - 1);
    }
    if (ok > 0) toast.success(`Uploaded ${ok} design${ok > 1 ? "s" : ""}`);
    errors.slice(0, 3).forEach((e) => toast.error(e));

    // Separate the images that were just uploaded.
    //
    // The user's own background-removal service does this best, so when one
    // is configured the upload is separated straight away: no button to
    // press, and no 25 MB model to download first.
    if (uploaded.length > 0) await separateUploaded(uploaded);
  };

  /**
   * Removes the background of every design that was just uploaded.
   *
   * The user's own service is used rather than the local engines: this is the
   * case they set a key up for. A design that cannot be separated is
   * reported, and the ORIGINAL is always kept.
   */
  const separateUploaded = async (uploaded: Design[]) => {
    let configured = false;
    try {
      const { hasBgRemoveKey, loadIntegrations } = await import("@/lib/client/integrations");
      configured = hasBgRemoveKey(await loadIntegrations());
    } catch {
      configured = false;
    }
    if (!configured) return;

    let separated = 0;
    for (const design of uploaded) {
      try {
        const blob = await getAssetBlob(design.originalAssetId);
        if (!blob) continue;
        const out = await removeBackgroundAuto(blob, { engine: "api" });
        const asset = await storeAsset(out.blob, `${design.name}-cutout.png`, "design-processed", {
          parentId: design.originalAssetId,
        });
        await db.designs.update(design.id, {
          processedAssetId: asset.id,
          updatedAt: Date.now(),
        });
        await logActivity(
          "bgremoval.run",
          `Separated "${design.name}" after upload with the ${out.engine} engine (${Math.round(out.removed * 100)}% of pixels changed)`,
        );
        separated++;
      } catch (e) {
        toast.error(
          `"${design.name}": ${e instanceof Error ? e.message : "could not be separated"}`,
        );
      }
    }
    if (separated > 0) {
      toast.success(
        `Separated ${separated} design${separated > 1 ? "s" : ""} from the background`,
      );
    }
  };

  /**
   * Removes the background of every selected design, one at a time.
   *
   * The work is CPU-bound, so it is done sequentially with a yield between
   * designs: otherwise the progress bar never paints and the tab freezes.
   *
   * The engine picks itself ("auto") unless the user asks for a specific
   * one: the cheap flood key runs first and the AI segmenter is only used
   * when the cheap one provably cannot help. The stage is shown as it
   * happens, because the AI engine downloads a ~25 MB model on its first
   * run and a silent spinner there looks like a freeze.
   */
  const removeBackgrounds = async () => {
    if (selected.length === 0) return;
    const ids = [...selected];
    setBusy({ done: 0, total: ids.length, current: "" });
    resetStages();
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      const design = await db.designs.get(id);
      if (!design) {
        done++;
        continue;
      }
      setBusy((b) => (b ? { ...b, current: design.name } : b));
      resetStages();
      try {
        const sourceId = design.originalAssetId;
        const blob = await getAssetBlob(sourceId);
        if (!blob) throw new Error(`Could not read "${design.name}" from storage`);
        const out = await removeBackgroundAuto(blob, {
          engine,
          tolerance,
          onProgress: showStage,
        });
        // The engine does the honest checks itself - "nothing was removed"
        // and "the artwork itself was the background" are both thrown as
        // messages that are safe to show, so all that is left here is to
        // name the design the message is about.
        const asset = await storeAsset(out.blob, `${design.name}-cutout.png`, "design-processed", {
          parentId: design.originalAssetId,
        });
        await db.designs.update(design.id, {
          processedAssetId: asset.id,
          updatedAt: Date.now(),
        });
        await logActivity(
          "bgremoval.run",
          `Removed background from "${design.name}" with the ${out.engine} engine (${Math.round(out.removed * 100)}% of pixels changed)`,
        );
      } catch (e) {
        failed++;
        const message = e instanceof Error ? e.message : `Could not process "${design.name}"`;
        toast.error(
          message.startsWith(`"${design.name}"`) ? message : `"${design.name}": ${message}`,
        );
      }
      done++;
      setBusy({ done, total: ids.length, current: design.name });
      // Let the browser paint the progress bar.
      await new Promise((r) => setTimeout(r, 0));
    }
    // The last stage ("Done") has to be seen before the box goes away.
    await new Promise((r) => setTimeout(r, MIN_STAGE_MS));
    setBusy(null);
    resetStages();
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
        <div
          className="rounded-lg border border-border-subtle bg-surface px-4 py-3 shadow-card"
          data-bg-progress=""
        >
          <div className="flex items-center gap-2 text-[13px] text-ink">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="truncate">
              {busy.current ? `Removing background from "${busy.current}"` : "Working…"}
            </span>
            <span className="ml-auto shrink-0 text-ink-subtle">
              {busy.done} / {busy.total}
            </span>
          </div>
          {stage && (
            <p className="mt-1 pl-[22px] text-[11px] text-ink-muted" data-bg-stage="">
              {stage}
            </p>
          )}
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
            <div className="w-[190px] space-y-1">
              <Label className="text-[11px] text-ink-muted">Engine</Label>
              <Select value={engine} onValueChange={(v) => setEngine(v as RemoveEngine)}>
                <SelectTrigger className="h-8 text-[12px]" aria-label="Background removal engine">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (recommended)</SelectItem>
                  <SelectItem value="flood-key">Flood-key (solid backgrounds)</SelectItem>
                  <SelectItem value="border-model">Border-model (faded backdrops)</SelectItem>
                  <SelectItem value="ai-segmenter">AI segmentation (photos)</SelectItem>
                  <SelectItem value="api">API (your own key)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {engine !== "ai-segmenter" && (
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

      {/* Both rows are always shown, even when one of them is empty. */}
      {ROWS.map((row) => (
        <DesignGallery
          key={row}
          row={row}
          designs={rows[row]}
          swatches={swatchesForRow(row)}
          designColours={designColours}
          selectedIds={selected}
          showCheckbox
          onToggle={toggle}
          indexOffset={row === "ink" ? rows.plain.length : 0}
          paused={paused}
        />
      ))}
    </div>
  );
}

/** The swatches a design's colours resolve to, used by the design cards. */
export function swatchesForColors(
  colors: string[],
  blackInkColors: string[],
  hasInkVariants: boolean,
): DesignSwatch[] {
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
