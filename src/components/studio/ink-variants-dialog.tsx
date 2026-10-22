"use client";

import * as React from "react";
import { toast } from "sonner";
import { createInkVariantBlob } from "@/lib/canvas/compose";
import { decodeImage } from "@/lib/image/image";
import { getAssetBlob, setInkVariantAsset } from "@/lib/db/repo";
import { db } from "@/lib/db/schema";
import type { Design, InkVariant } from "@/types/domain";
import { AssetThumb } from "@/components/asset-thumb";
import { Button } from "@/components/ui/button";
import { Badge, Separator } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Upload } from "lucide-react";

const canvasToBlobPng = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), "image/png"),
  );

function VariantSlot({
  label,
  description,
  assetId,
  onGenerate,
  onUpload,
  onRemove,
  busy,
}: {
  label: string;
  description: string;
  assetId?: string;
  onGenerate?: () => void;
  onUpload?: (file: File) => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {assetId ? <Badge>created</Badge> : <Badge variant="outline">missing</Badge>}
      </div>
      <AssetThumb assetId={assetId ?? ""} className="h-[150px] w-full rounded-md border border-border-subtle" checkerboard />
      <p className="min-h-[28px] text-[11px] leading-relaxed text-ink-muted">{description}</p>
      <div className="flex flex-wrap gap-1.5">
        {onGenerate && !assetId && (
          <Button variant="outline" size="sm" onClick={onGenerate} disabled={busy}>
            {busy ? "Generating…" : "Auto-generate"}
          </Button>
        )}
        {onUpload && (
          <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
            <Upload className="h-3 w-3" /> {assetId ? "Replace" : "Upload"}
          </Button>
        )}
        {assetId && onRemove && (
          <Button variant="ghost" size="sm" className="text-danger" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && onUpload) onUpload(f);
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </div>
  );
}

export function InkVariantsDialog({
  design,
  onClose,
}: {
  design: Design;
  onClose: () => void;
}) {
  const [busy, setBusy] = React.useState<"white" | "black" | null>(null);
  const [live, setLive] = React.useState<Design | null>(null);
  const current = live ?? design;

  React.useEffect(() => {
    // Poll the design record while the dialog is open so edits reflect instantly.
    const t = setInterval(async () => {
      const d = await db.designs.get(design.id);
      if (d) setLive(d);
    }, 400);
    return () => clearInterval(t);
  }, [design.id]);

  const generate = async (ink: "white" | "black") => {
    setBusy(ink);
    try {
      const blob = await getAssetBlob(current.processedAssetId ?? current.originalAssetId);
      if (!blob) throw new Error("Could not read the design file");
      const bmp = await decodeImage(blob);
      const { blob: outBlob } = await createInkVariantBlob(bmp, ink, canvasToBlobPng);
      bmp.close();
      await setInkVariantAsset(current.id, ink, outBlob, `${current.name}-${ink}-ink.png`);
      toast.success(`${ink === "white" ? "White" : "Black"} ink variant created — review it before use`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create ink variant");
    } finally {
      setBusy(null);
    }
  };

  const uploadVariant = async (ink: "white" | "black", file: File) => {
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error("File is too large (limit 40 MB)");
      await setInkVariantAsset(current.id, ink, file, file.name);
      toast.success(`${ink === "white" ? "White" : "Black"} ink variant uploaded`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    }
  };

  const removeVariant = async (ink: "white" | "black") => {
    const d = await db.designs.get(current.id);
    if (!d) return;
    const clone: Design = { ...d, updatedAt: Date.now() };
    if (ink === "white") delete clone.whiteInkAssetId;
    else delete clone.blackInkAssetId;
    if (clone.activeVariant === ink) clone.activeVariant = "main";
    await db.designs.put(clone);
    toast.success(`${ink} ink variant removed from this design`);
  };

  const setActive = async (variant: InkVariant) => {
    const d = await db.designs.get(current.id);
    if (!d) return;
    if (variant === "white" && !d.whiteInkAssetId) return;
    if (variant === "black" && !d.blackInkAssetId) return;
    await db.designs.put({ ...d, activeVariant: variant, updatedAt: Date.now() });
    toast.success(`Default output variant set to ${variant === "main" ? "main design" : `${variant} ink`}`);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ink variants — {current.name}</DialogTitle>
          <DialogDescription>
            Three independently managed versions. Auto-generation maps every visible pixel to a flat
            ink color while preserving alpha — gradients become flat, so review results and replace
            with your own file when needed. The main design is never modified.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <VariantSlot
            label="Main design"
            description="The original artwork (or its background-removed version) placed on products."
            assetId={current.processedAssetId ?? current.originalAssetId}
          />
          <VariantSlot
            label="White ink"
            description="All visible pixels flattened to white. For dark garments."
            assetId={current.whiteInkAssetId}
            onGenerate={() => generate("white")}
            onUpload={(f) => uploadVariant("white", f)}
            onRemove={() => removeVariant("white")}
            busy={busy === "white"}
          />
          <VariantSlot
            label="Black ink"
            description="All visible pixels flattened to black. For light garments."
            assetId={current.blackInkAssetId}
            onGenerate={() => generate("black")}
            onUpload={(f) => uploadVariant("black", f)}
            onRemove={() => removeVariant("black")}
            busy={busy === "black"}
          />
        </div>

        <Separator />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] text-ink-muted">Default variant used by batches:</div>
          <div className="flex gap-1.5">
            {(["main", "white", "black"] as InkVariant[]).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={current.activeVariant === v ? "default" : "outline"}
                disabled={v !== "main" && !(v === "white" ? current.whiteInkAssetId : current.blackInkAssetId)}
                onClick={() => setActive(v)}
              >
                {v === "main" ? "Main" : v === "white" ? "White ink" : "Black ink"}
              </Button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
