"use client";

import * as React from "react";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import { designMainAssetId, getAssetBlob, logActivity } from "@/lib/db/repo";
import {
  removeBackground,
  setBgRemovalProgressCallback,
  type BgRemovalEngineId,
} from "@/lib/bg-removal/engine";
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

interface BgResult {
  blob: Blob;
  transparency: number;
}

export function BgRemovalDialog({
  designs,
  onClose,
}: {
  designs: Design[];
  onClose: () => void;
}) {
  const [engine, setEngine] = React.useState<BgRemovalEngineId>("flood-key");
  const [tolerance, setTolerance] = React.useState(FLOOD_KEY_DEFAULTS.tolerance);
  const [state, setState] = React.useState<ProcessingState>("idle");
  const [stage, setStage] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BgResult | null>(null);
  const [savedCount, setSavedCount] = React.useState(0);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    setBgRemovalProgressCallback((s) => setStage(s));
    return () => setBgRemovalProgressCallback(null);
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
      try {
        let last: BgResult | null = null;
        let saved = 0;
        for (const design of designs) {
          const sourceId = designMainAssetId(design);
          const blob = await getAssetBlob(sourceId);
          if (!blob) throw new Error(`Could not read "${design.name}" from storage`);
          const out = await removeBackground(engine, blob, tolerance);
          last = out;
          if (out.transparency < 0.005) {
            throw new Error(
              `"${design.name}": no background was detected. Try a higher tolerance, or the AI engine for photos/complex backgrounds.`,
            );
          }
          if (designs.length > 1) {
            // Batch mode: save each processed result immediately.
            const { storeAsset } = await import("@/lib/db/repo");
            const asset = await storeAsset(out.blob, `${design.name}-cutout.png`, "design-processed", {
              parentId: design.originalAssetId,
            });
            await db.designs.update(design.id, { processedAssetId: asset.id, updatedAt: Date.now() });
            await logActivity("bgremoval.run", `Removed background from "${design.name}" (${Math.round(out.transparency * 100)}% transparent)`);
            saved++;
            setSavedCount(saved);
          }
        }
        if (last) setResult(last);
        setState("done");
        if (designs.length === 1) {
          toast.success("Background removed â€” review the result, then apply it to the design");
        } else {
          toast.success(`Background removed and applied to ${saved} design${saved > 1 ? "s" : ""}`);
          onClose();
        }
      } catch (e) {
        setState("failed");
        setError(e instanceof Error ? e.message : "Background removal failed");
      }
    },
    [designs, engine, tolerance, onClose],
  );

  const applyToDesign = async () => {
    if (!result || designs.length !== 1) return;
    const design = designs[0];
    const { storeAsset } = await import("@/lib/db/repo");
    const asset = await storeAsset(result.blob, `${design.name}-cutout.png`, "design-processed", {
      parentId: design.originalAssetId,
    });
    await db.designs.update(design.id, { processedAssetId: asset.id, updatedAt: Date.now() });
    await logActivity("bgremoval.run", `Removed background from "${design.name}" (${Math.round(result.transparency * 100)}% transparent)`);
    toast.success(`Applied to "${design.name}" â€” the original file is preserved`);
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
            Remove background â€” {single ? designs[0].name : `${designs.length} designs`}
          </DialogTitle>
          <DialogDescription>
            The original file is always preserved. The processed cutout becomes the design&rsquo;s placed artwork.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-[220px] space-y-1">
              <Label className="text-ink-muted">Engine</Label>
              <Select value={engine} onValueChange={(v) => setEngine(v as BgRemovalEngineId)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="flood-key">Flood-key (solid backgrounds, instant)</SelectItem>
                  <SelectItem value="ai-segmenter">AI segmentation (photos, complex)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {engine === "flood-key" && (
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

          {engine === "ai-segmenter" && (
            <p className="text-[12px] leading-relaxed text-ink-muted">
              Runs the open-source MODNet model (MIT license) entirely in your browser â€” images never
              leave this machine. First use downloads ~25 MB, cached afterwards. MODNet is trained for
              photos of people and product shots; for flat artwork on solid backgrounds the flood-key
              engine is usually faster and cleaner.
            </p>
          )}

          {state === "processing" && (
            <div className="flex items-center gap-2 rounded-md bg-surface-muted px-3 py-2 text-[13px] text-ink-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {stage || "Processingâ€¦"}
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
                  Before / after â€” {Math.round(result.transparency * 100)}% of pixels now transparent
                </span>
                <Badge variant={result.transparency > 0.05 ? "default" : "warning"}>
                  {result.transparency > 0.05 ? "transparent background" : "little transparency detected"}
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
          {!single && state === "done" && <span className="text-[13px] text-forest">All done â€” results applied.</span>}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
