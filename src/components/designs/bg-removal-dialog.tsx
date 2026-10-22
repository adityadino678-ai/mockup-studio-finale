"use client";

import * as React from "react";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import { getAssetBlob, logActivity } from "@/lib/db/repo";
import { removeBackgroundAuto, type RemoveEngine, type RemoveOutcome } from "@/lib/printify/remove-background";
import { FLOOD_KEY_DEFAULTS } from "@/lib/bg-removal/flood-key";
import type { Design } from "@/types/domain";
import { AssetThumb } from "@/components/asset-thumb";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Label } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Slider } from "@/components/ui/primitives";
import { Download, Loader2, RotateCcw, Wand2 } from "lucide-react";

type ProcessingState = "idle" | "processing" | "done" | "failed";

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

interface BgResult {
  blob: Blob;
  /** Fraction of pixels whose ALPHA CHANGED - the honest measure of a removal. */
  removed: number;
  /** Which engine actually did the work. */
  engine: RemoveOutcome["engine"];
}

export function BgRemovalDialog({
  designs,
  onClose,
}: {
  designs: Design[];
  onClose: () => void;
}) {
  const [engine, setEngine] = React.useState<RemoveEngine>("auto");
  const [tolerance, setTolerance] = React.useState(FLOOD_KEY_DEFAULTS.tolerance);
  const [state, setState] = React.useState<ProcessingState>("idle");
  const [stage, setStage] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BgResult | null>(null);
  const [savedCount, setSavedCount] = React.useState(0);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  /** The stages that are waiting for their turn on screen - see `showStage`. */
  const stageQueue = React.useRef<string[]>([]);
  const stageShownAt = React.useRef(0);
  const stageTimer = React.useRef<number | null>(null);

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

  // Show before/after for a single result.
  React.useEffect(() => {
    if (result) {
      const url = URL.createObjectURL(result.blob);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreviewUrl(null);
  }, [result]);

  const run = React.useCallback(
    async (retrying = false) => {
      if (designs.length === 0) return;
      setState("processing");
      setError(null);
      if (!retrying) setResult(null);
      setSavedCount(0);
      resetStages();
      try {
        let last: BgResult | null = null;
        let saved = 0;
        for (const design of designs) {
          const sourceId = design.originalAssetId;
          const blob = await getAssetBlob(sourceId);
          if (!blob) throw new Error(`Could not read "${design.name}" from storage`);
          resetStages();
          let out: RemoveOutcome;
          try {
            // The per-call `onProgress` is used instead of the global sink so
            // another caller cannot steal the stages mid-run.
            out = await removeBackgroundAuto(blob, {
              engine,
              tolerance,
              onProgress: showStage,
            });
          } catch (e) {
            // The engine's own message is written for one image and says
            // nothing about WHICH design failed, which is ambiguous in a
            // batch - so the design's name is put in front of it.
            const message = e instanceof Error ? e.message : "Background removal failed";
            throw new Error(
              message.startsWith(`"${design.name}"`) ? message : `"${design.name}": ${message}`,
            );
          }
          last = { blob: out.blob, removed: out.removed, engine: out.engine };
          // The engine refuses a no-op and an emptied image itself, so all
          // that is left is a light guard: a result that changed less than
          // half a percent must never be shown to the user as a success.
          if (out.removed < 0.005) {
            throw new Error(
              `"${design.name}": no background was detected, so the image was left unchanged. Try a higher tolerance, or the AI segmentation engine for photos and complex backgrounds.`,
            );
          }
          if (designs.length > 1) {
            // Batch mode: save each processed result immediately.
            const { storeAsset } = await import("@/lib/db/repo");
            const asset = await storeAsset(out.blob, `${design.name}-cutout.png`, "design-processed", {
              parentId: design.originalAssetId,
            });
            await db.designs.update(design.id, { processedAssetId: asset.id, updatedAt: Date.now() });
            await logActivity(
              "bgremoval.run",
              `Removed background from "${design.name}" with the ${out.engine} engine (${Math.round(out.removed * 100)}% of pixels changed)`,
            );
            saved++;
            setSavedCount(saved);
          }
        }
        if (last) setResult(last);
        setState("done");
        if (designs.length === 1) {
          toast.success("Background removed — review the result, then apply it to the design");
        } else {
          toast.success(`Background removed and applied to ${saved} design${saved > 1 ? "s" : ""}`);
          onClose();
        }
      } catch (e) {
        setState("failed");
        setError(e instanceof Error ? e.message : "Background removal failed");
      }
    },
    [designs, engine, tolerance, onClose, showStage, resetStages],
  );

  const applyToDesign = async () => {
    if (!result || designs.length !== 1) return;
    const design = designs[0];
    const { storeAsset } = await import("@/lib/db/repo");
    const asset = await storeAsset(result.blob, `${design.name}-cutout.png`, "design-processed", {
      parentId: design.originalAssetId,
    });
    await db.designs.update(design.id, { processedAssetId: asset.id, updatedAt: Date.now() });
    await logActivity(
      "bgremoval.run",
      `Removed background from "${design.name}" with the ${result.engine} engine (${Math.round(result.removed * 100)}% of pixels changed)`,
    );
    toast.success(`Applied to "${design.name}" — the original file is preserved`);
    onClose();
  };

  const download = () => {
    if (!result || !previewUrl) return;
    const a = document.createElement("a");
    a.href = previewUrl;
    a.download = `${designs[0]?.name ?? "design"}-cutout.png`;
    a.click();
  };

  const single = designs.length === 1;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-forest" />
            Remove background — {single ? designs[0].name : `${designs.length} designs`}
          </DialogTitle>
          <DialogDescription>
            The original file is always preserved. The processed cutout becomes the design&rsquo;s placed artwork.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-[220px] space-y-1">
              <Label className="text-ink-muted">Engine</Label>
              <Select value={engine} onValueChange={(v) => setEngine(v as RemoveEngine)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (recommended)</SelectItem>
                  <SelectItem value="flood-key">Flood-key (solid backgrounds, instant)</SelectItem>
                  <SelectItem value="border-model">Border-model (gradients and vignettes, instant)</SelectItem>
                  <SelectItem value="ai-segmenter">AI segmentation (photos, complex)</SelectItem>
                  <SelectItem value="api">API (your own key)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(engine === "auto" || engine === "flood-key" || engine === "border-model") && (
              <div className="w-[200px] space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-ink-muted">Color tolerance</Label>
                  <span className="text-[12px] text-ink">{tolerance}</span>
                </div>
                <Slider
                  value={[tolerance]}
                  min={5}
                  max={120}
                  step={1}
                  onValueChange={(v) => setTolerance(v[0])}
                />
              </div>
            )}
            <Button size="sm" onClick={() => run()} disabled={state === "processing"}>
              {state === "processing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              {single ? (state === "done" ? "Re-run" : "Remove background") : "Process all"}
            </Button>
          </div>

          <p className="text-[12px] leading-relaxed text-ink-muted">
            Auto runs the instant engines first and only downloads the AI model (~25 MB, first use only)
            when they cannot do it.
          </p>

          {engine === "ai-segmenter" && (
            <p className="text-[12px] leading-relaxed text-ink-muted">
              Runs the open-source MODNet model (MIT license) entirely in your browser — images never
              leave this machine. First use downloads ~25 MB, cached afterwards. MODNet is trained for
              photos of people and product shots; for flat artwork on solid backgrounds the flood-key
              engine is usually faster and cleaner.
            </p>
          )}

          {state === "processing" && (
            <div className="flex items-center gap-2 rounded-md bg-surface-muted px-3 py-2 text-[13px] text-ink-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {stage || "Processing…"}
              {!single && savedCount > 0 && ` Â· ${savedCount} saved`}
            </div>
          )}

          {state === "failed" && (
            <div className="space-y-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5">
              <p className="text-[13px] text-danger">{error}</p>
              <Button variant="outline" size="sm" onClick={() => run(true)}>
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          )}

          {result && previewUrl && single && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium text-ink-muted">
                  Before / after - {Math.round(result.removed * 100)}% of pixels removed
                </span>
                <Badge variant={result.removed >= 0.05 ? "default" : "warning"}>
                  {result.removed >= 0.05 ? "background removed" : "little was removed"}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <AssetThumb assetId={designs[0].originalAssetId} className="h-[240px] w-full rounded-md border border-border-subtle" checkerboard />
                  <div className="mt-1 text-center text-[11px] text-ink-subtle">original</div>
                </div>
                {/* local blob preview */}
                <img
                  src={previewUrl}
                  alt="Background removed preview"
                  className="checkerboard h-[240px] w-full rounded-md border border-border-subtle object-contain"
                />
              </div>
              <div className="mt-1 text-center text-[11px] text-ink-subtle">processed (checkered = transparency)</div>
              {result.removed < 0.05 && (
                <p className="mt-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-warning">
                  Only {Math.round(result.removed * 100)}% of the pixels changed - the {result.engine}{" "}
                  engine could not find a background to remove. Try the AI segmentation engine for
                  photos and complex backgrounds.
                </p>
              )}
            </div>
          )}

          {single && designs[0].processedAssetId && (
            <p className="text-[12px] text-ink-muted">
              This design already has a processed cutout. Re-running replaces it (the previous
              processed file is kept in storage until replaced by a new run).
            </p>
          )}
        </div>

        <DialogFooter>
          {single && state === "done" && (
            <>
              <Button variant="outline" size="sm" onClick={download}>
                <Download className="h-3.5 w-3.5" /> Download PNG
              </Button>
              <Button size="sm" onClick={applyToDesign}>
                Apply to design
              </Button>
            </>
          )}
          {!single && state === "done" && <span className="text-[13px] text-forest">All done — results applied.</span>}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
