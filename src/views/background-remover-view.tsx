"use client";

import * as React from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { HowItWorks } from "@/components/ui/how-it-works";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UploadDropzone } from "@/components/upload-dropzone";
import { removeBackgroundAuto, type RemoveMode } from "@/lib/printify/remove-background";
import { createDesignFromBlob } from "@/lib/db/repo";
import { validateImageFile } from "@/lib/image/image";
import { cn } from "@/lib/utils";
import { Brush, Eraser, Undo2, ZoomIn, ZoomOut, Download, Save, X } from "lucide-react";

type PreviewBg = "checker" | "light" | "dark";
type Job = {
  id: string;
  file: File;
  originalUrl: string;
  resultUrl?: string;
  resultBlob?: Blob;
  stage: string;
  status: "queued" | "running" | "done" | "error";
  error?: string;
  engineLabel?: string;
};

const checkerStyle: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,0 8px,8px -8px,-8px 0px",
  backgroundColor: "#fff",
};

export function BackgroundRemoverView() {
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<RemoveMode>("auto");
  const [modelSize, setModelSize] = React.useState<"small" | "large">("small");
  const [tolerance, setTolerance] = React.useState(32);
  const [feather, setFeather] = React.useState(1);
  const [previewBg, setPreviewBg] = React.useState<PreviewBg>("checker");
  const [sliderPos, setSliderPos] = React.useState(50);
  const [zoom, setZoom] = React.useState(1);
  const [brush, setBrush] = React.useState(24);
  const [brushMode, setBrushMode] = React.useState<"erase" | "restore">("erase");
  const [extraColour, setExtraColour] = React.useState<{ r: number; g: number; b: number } | null>(null);
  const [picking, setPicking] = React.useState(false);
  const [downloadPct, setDownloadPct] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const originalCanvasRef = React.useRef<HTMLCanvasElement>(null);
  const historyRef = React.useRef<ImageData[]>([]);
  const paintingRef = React.useRef(false);

  const active = jobs.find((j) => j.id === activeId) ?? jobs[0];

  const addFiles = (files: File[]) => {
    const next: Job[] = files.map((file, i) => ({
      id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
      file,
      originalUrl: URL.createObjectURL(file),
      stage: "Queued",
      status: "queued" as const,
    }));
    setJobs((prev) => [...prev, ...next]);
    if (!activeId && next[0]) setActiveId(next[0].id);
    // Auto-start the queue.
    void runQueue(next);
  };

  const updateJob = (id: string, patch: Partial<Job>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const runQueue = async (initial: Job[]) => {
    if (busy) return;
    setBusy(true);
    const queue = [...initial];
    for (const job of queue) {
      // Yield so the browser never freezes between files.
      await new Promise((r) => setTimeout(r, 0));
      const v = validateImageFile(job.file);
      if (!v.ok) {
        updateJob(job.id, { status: "error", error: v.error });
        continue;
      }
      updateJob(job.id, { status: "running", stage: "Removing background…" });
      try {
        const out = await removeBackgroundAuto(job.file, {
          mode,
          modelSize,
          tolerance,
          feather,
          extraColour: undefined,
          onProgress: (s) => updateJob(job.id, { stage: s }),
          onDownload: (loaded, total) =>
            setDownloadPct(total > 0 ? Math.round((loaded / total) * 100) : null),
        });
        const url = URL.createObjectURL(out.blob);
        updateJob(job.id, {
          status: "done",
          stage: "Done",
          resultBlob: out.blob,
          resultUrl: url,
          engineLabel: out.engine === "ml" ? "ML segmentation" : out.engine,
        });
        if (out.warning) toast.message(out.warning);
      } catch (e) {
        updateJob(job.id, {
          status: "error",
          error: e instanceof Error ? e.message : "Removal failed",
        });
      } finally {
        setDownloadPct(null);
      }
    }
    setBusy(false);
  };

  const rerunActive = async () => {
    if (!active) return;
    updateJob(active.id, { status: "running", stage: "Removing background…" });
    try {
      const out = await removeBackgroundAuto(active.file, {
        mode,
        modelSize,
        tolerance,
        feather,
        extraColour,
        onProgress: (s) => updateJob(active.id, { stage: s }),
        onDownload: (loaded, total) =>
          setDownloadPct(total > 0 ? Math.round((loaded / total) * 100) : null),
      });
      updateJob(active.id, {
        status: "done",
        stage: "Done",
        resultBlob: out.blob,
        resultUrl: URL.createObjectURL(out.blob),
      });
      if (out.warning) toast.message(out.warning);
    } catch (e) {
      updateJob(active.id, { status: "error", error: e instanceof Error ? e.message : "Removal failed" });
    } finally {
      setDownloadPct(null);
    }
  };

  // Load the active result into the editable canvas.
  React.useEffect(() => {
    if (!active?.resultUrl) return;
    const img = new Image();
    img.onload = () => {
      const c = canvasRef.current;
      const oc = originalCanvasRef.current;
      if (!c) return;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      historyRef.current = [ctx.getImageData(0, 0, c.width, c.height)];
      if (oc) {
        oc.width = img.naturalWidth;
        oc.height = img.naturalHeight;
        const octx = oc.getContext("2d");
        octx?.drawImage(img, 0, 0);
      }
    };
    img.src = active.resultUrl;
  }, [active?.id, active?.resultUrl]);

  const canvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    return {
      x: Math.floor(((e.clientX - rect.left) / rect.width) * c.width),
      y: Math.floor(((e.clientY - rect.top) / rect.height) * c.height),
    };
  };

  const pushHistory = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const h = historyRef.current;
    h.push(ctx.getImageData(0, 0, c.width, c.height));
    if (h.length > 20) h.shift();
  };

  const undo = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    const h = historyRef.current;
    if (!c || !ctx || h.length <= 1) return;
    h.pop();
    ctx.putImageData(h[h.length - 1], 0, 0);
  };

  const onCanvasPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (picking) {
      const c = canvasRef.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return;
      const { x, y } = canvasPoint(e);
      const d = ctx.getImageData(
        Math.max(0, Math.min(c.width - 1, x)),
        Math.max(0, Math.min(c.height - 1, y)),
        1,
        1,
      ).data;
      setExtraColour({ r: d[0], g: d[1], b: d[2] });
      setPicking(false);
      toast.success("Extra colour picked");
      return;
    }
    if (!paintingRef.current) return;
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    const oc = originalCanvasRef.current?.getContext("2d");
    if (!c || !ctx || !oc) return;
    const { x, y } = canvasPoint(e);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, brush / 2 / zoom, 0, Math.PI * 2);
    ctx.clip();
    if (brushMode === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.fillRect(x - brush, y - brush, brush * 2, brush * 2);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(originalCanvasRef.current!, 0, 0, c.width, c.height);
    }
    ctx.restore();
  };

  const downloadActive = () => {
    if (!active?.resultBlob) return;
    const url = URL.createObjectURL(active.resultBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.file.name.replace(/\.[^.]+$/, "")}-no-bg.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const saveActive = async () => {
    if (!active?.resultBlob) return;
    try {
      const design = await createDesignFromBlob(
        active.resultBlob,
        `${active.file.name.replace(/\.[^.]+$/, "")}-cutout.png`,
      );
      toast.success(`Saved "${design.name}" to my designs`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    }
  };

  const _done = jobs.filter((j) => j.status === "done").length;
  const _failed = jobs.filter((j) => j.status === "error").length;
  void _done;
  void _failed;

  return (
    <div className="mx-auto max-w-6xl p-5 sm:p-8" data-bg-remover-page="">
      <PageHeader
        title="Background Remover"
        description="Drop cut-outs here. Edges stay sharp at full size."
        actions={
          <>
            <HowItWorks
              title="Background Remover"
              steps={[
                "Drop one or many images.",
                "Choose Auto, Artwork, or Photo.",
                "Review the cutout, adjust, and download.",
              ]}
            />
            <Button size="sm" variant="outline" onClick={downloadActive} disabled={!active?.resultBlob}>
              <Download className="h-3.5 w-3.5" /> PNG
            </Button>
            <Button size="sm" onClick={saveActive} disabled={!active?.resultBlob}>
              <Save className="h-3.5 w-3.5" /> Save to my designs
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <UploadDropzone onFiles={addFiles} label="Drop images" hint="PNG, JPG, WebP · 40 MB max" />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setMode("auto")}
                  className={cn("rounded border px-2 py-1 text-sm", mode === "auto" ? "border-forest bg-surface font-semibold" : "border-border-subtle")}
                >
                  Auto
                </button>
                <button
                  type="button"
                  onClick={() => setMode("artwork")}
                  className={cn("rounded border px-2 py-1 text-sm", mode === "artwork" ? "border-forest bg-surface font-semibold" : "border-border-subtle")}
                >
                  Artwork / logo
                </button>
                <button
                  type="button"
                  onClick={() => setMode("photo")}
                  className={cn("rounded border px-2 py-1 text-sm", mode === "photo" ? "border-forest bg-surface font-semibold" : "border-border-subtle")}
                >
                  Photo / object
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setModelSize("small")}
                  className={cn("rounded border px-2 py-1 text-sm", modelSize === "small" ? "border-forest bg-surface font-semibold" : "border-border-subtle")}
                >
                  Fast model
                </button>
                <button
                  type="button"
                  onClick={() => setModelSize("large")}
                  className={cn("rounded border px-2 py-1 text-sm", modelSize === "large" ? "border-forest bg-surface font-semibold" : "border-border-subtle")}
                >
                  Accurate model
                </button>
              </div>
              {downloadPct !== null && (
                <div role="progressbar" aria-valuenow={downloadPct} className="h-2 overflow-hidden rounded bg-surface-muted">
                  <div className="h-full bg-forest" style={{ width: `${downloadPct}%` }} />
                </div>
              )}
              {downloadPct !== null && <p className="text-sm text-ink-muted">Downloading model… {downloadPct}%</p>}
              <label className="block text-sm">
                Tolerance
                <input type="range" min={5} max={80} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} className="w-full" aria-label="Tolerance" />
                <span className="text-sm text-ink-muted">{tolerance}</span>
              </label>
              <label className="block text-sm">
                Edge softness
                <input type="range" min={0} max={2} value={feather} onChange={(e) => setFeather(Number(e.target.value))} className="w-full" aria-label="Edge softness" />
                <span className="text-sm text-ink-muted">{feather}px</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setPicking((v) => !v)} className={cn("rounded border px-2 py-1 text-sm", picking ? "border-forest bg-surface font-semibold" : "border-border-subtle")}>
                  {picking ? "Click the image…" : "Remove one extra colour"}
                </button>
                {extraColour && (
                  <span className="inline-flex items-center gap-1 text-sm">
                    <span className="inline-block h-4 w-4 rounded-full border" style={{ backgroundColor: `rgb(${extraColour.r},${extraColour.g},${extraColour.b})` }} />
                    <button type="button" onClick={() => setExtraColour(null)} className="underline">clear</button>
                  </span>
                )}
              </div>
              <Button size="sm" className="w-full" onClick={rerunActive} disabled={!active || busy}>
                Re-run
              </Button>
              {jobs.length > 0 && (
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {jobs.map((j) => (
                    <li key={j.id}>
                      <button
                        type="button"
                        onClick={() => setActiveId(j.id)}
                        className={cn("flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-sm", active?.id === j.id ? "border-forest" : "border-border-subtle")}
                      >
                        <span className="truncate">{j.file.name}</span>
                        <span className="shrink-0 text-sm text-ink-muted">
                          {j.status === "running" ? j.stage : j.status === "done" ? `Done${j.engineLabel ? ` (${j.engineLabel})` : ""}` : j.status === "error" ? "Failed" : "Queued"}
                        </span>
                      </button>
                      {j.status === "error" && <p className="text-sm text-danger">{j.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap gap-1" aria-label="Preview background">
                  {(["checker", "light", "dark"] as PreviewBg[]).map((bg) => (
                    <button
                      key={bg}
                      type="button"
                      onClick={() => setPreviewBg(bg)}
                      className={cn("rounded border px-2 py-1 text-sm", previewBg === bg ? "border-forest bg-surface font-semibold" : "border-border-subtle")}
                    >
                      {bg === "checker" ? "Checker" : bg === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
                <span className="flex items-center gap-1">
                  <Button size="sm" variant="outline" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} aria-label="Zoom out"><ZoomOut className="h-3.5 w-3.5" /></Button>
                  <span className="text-sm">{Math.round(zoom * 100)}%</span>
                  <Button size="sm" variant="outline" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} aria-label="Zoom in"><ZoomIn className="h-3.5 w-3.5" /></Button>
                </span>
                <label className="flex items-center gap-1 text-sm">
                  Before / after
                  <input type="range" min={0} max={100} value={sliderPos} onChange={(e) => setSliderPos(Number(e.target.value))} className="w-28" aria-label="Before and after slider" />
                </label>
              </div>

              <div
                className={cn("relative overflow-hidden rounded border border-border-subtle", previewBg === "light" && "bg-white", previewBg === "dark" && "bg-[#101418]")}
                style={previewBg === "checker" ? checkerStyle : undefined}
                data-bg-preview=""
              >
                {!active ? (
                  <p className="p-10 text-center text-sm text-ink-muted">Drop an image to start.</p>
                ) : active.resultUrl ? (
                  <div className="relative" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}>
                    <canvas
                      ref={canvasRef}
                      className="block max-h-[520px] w-full cursor-crosshair object-contain"
                      onPointerDown={(e) => {
                        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                        pushHistory();
                        paintingRef.current = true;
                        onCanvasPointer(e);
                      }}
                      onPointerMove={onCanvasPointer}
                      onPointerUp={() => {
                        paintingRef.current = false;
                      }}
                      onPointerLeave={() => {
                        paintingRef.current = false;
                      }}
                      aria-label="Cutout canvas. Use the brush to erase or restore."
                    />
                    <canvas ref={originalCanvasRef} hidden />
                    <div
                      className="pointer-events-none absolute inset-y-0 border-l-2 border-forest"
                      style={{ left: `${sliderPos}%` }}
                      aria-hidden
                    />
                    <div
                      className="pointer-events-none absolute inset-y-0 overflow-hidden"
                      style={{ width: `${sliderPos}%` }}
                      aria-hidden
                    >
                      <img src={active.originalUrl} alt="" className="absolute inset-0 h-full w-full object-contain" />
                    </div>
                  </div>
                ) : (
                  <img src={active.originalUrl} alt={active.file.name} className="block max-h-[520px] w-full object-contain" />
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={brushMode === "erase" ? "default" : "outline"} onClick={() => setBrushMode("erase")}>
                  <Eraser className="h-3.5 w-3.5" /> Erase
                </Button>
                <Button size="sm" variant={brushMode === "restore" ? "default" : "outline"} onClick={() => setBrushMode("restore")}>
                  <Brush className="h-3.5 w-3.5" /> Restore
                </Button>
                <label className="flex items-center gap-1 text-sm">
                  Brush
                  <input type="range" min={6} max={64} value={brush} onChange={(e) => setBrush(Number(e.target.value))} aria-label="Brush size" />
                </label>
                <Button size="sm" variant="outline" onClick={undo}>
                  <Undo2 className="h-3.5 w-3.5" /> Undo
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setJobs((prev) => prev.filter((j) => j.id !== active?.id)); }}>
                  <X className="h-3.5 w-3.5" /> Remove file
                </Button>
                {active?.stage && <span className="text-sm text-ink-muted">{active.stage}</span>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
