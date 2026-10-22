"use client";

import * as React from "react";
import { Link, useRouter, useSearchParams } from "@/lib/client/nav";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import { getAssetBlob, getPlacement, savePlacement, storeAsset } from "@/lib/db/repo";
import { sanitizeFilename, decodeImage, canvasToBlob } from "@/lib/image/image";
import { composeToCanvas } from "@/lib/canvas/compose";
import { clipRect } from "@/lib/mockups/print-area";
import { transformFromPrintArea, writeBackStudioPlacement } from "@/lib/mockups/resolve";
import { placementForTransform } from "@/lib/mockups/resolve";
import { loadSession } from "@/lib/printify/studio-session";
import { useEditorStore, selectDirty, selectCanUndo, selectCanRedo, type EditorSnapshot } from "@/lib/store/editor";
import type { InkVariant, Template, Transform } from "@/types/domain";
import { DEFAULT_TRANSFORM } from "@/types/domain";
import { EditorPicker } from "@/components/editor/editor-picker";
// react-konva is ~360 kB of the editor bundle. Loading it on demand keeps it
// out of the initial payload for every other route and for the editor picker.
const EditorCanvas = React.lazy(() => import("@/components/editor/editor-canvas"));
import { PropertiesPanel } from "@/components/editor/properties-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/primitives";
import {
  ArrowLeft,
  Check,
  Download,
  FileImage,
  Images,
  MoveHorizontal,
  Redo2,
  Save,
  LayoutTemplate as TemplateIcon,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

export function EditorPage() {
  return (
    <React.Suspense fallback={<div className="p-8 text-[13px] text-ink-muted">Loading editorâ€¦</div>}>
      <EditorPageInner />
    </React.Suspense>
  );
}

function EditorPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const designId = searchParams.get("design");
  const mockupId = searchParams.get("mockup");

  if (!designId || !mockupId) {
    return (
      <EditorPicker
        initialDesignId={designId ?? undefined}
        initialMockupId={mockupId ?? undefined}
        onOpen={(d, m) => router.replace(`/editor?design=${d}&mockup=${m}`)}
      />
    );
  }
  return <EditorWorkspace designId={designId} mockupId={mockupId} />;
}

function EditorWorkspace({ designId, mockupId }: { designId: string; mockupId: string }) {
  const router = useRouter();

  const design = useLiveQuery(() => db.designs.get(designId), [designId]);
  const mockup = useLiveQuery(() => db.mockups.get(mockupId), [mockupId]);
  const allDesigns = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const allMockups = useLiveQuery(() => db.mockups.orderBy("name").toArray(), []);
  const placementTemplates = useLiveQuery(
    () => db.templates.where("category").equals("placement").toArray(),
    [],
  );

  const current = useEditorStore((s) => s.current);
  const isDirty = useEditorStore(selectDirty);
  const canUndo = useEditorStore(selectCanUndo);
  const canRedo = useEditorStore(selectCanRedo);
  const init = useEditorStore((s) => s.init);
  const update = useEditorStore((s) => s.update);
  const setTransform = useEditorStore((s) => s.setTransform);
  const commit = useEditorStore((s) => s.commit);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const markSaved = useEditorStore((s) => s.markSaved);
  const resetTransform = useEditorStore((s) => s.resetTransform);
  const clear = useEditorStore((s) => s.clear);

  const [selected, setSelected] = React.useState(false);
  const [zoom, setZoom] = React.useState(1);
  const [lockAspect, setLockAspect] = React.useState(true);
  const [mockupUrl, setMockupUrl] = React.useState<string | null>(null);
  const [designUrl, setDesignUrl] = React.useState<string | null>(null);
  const [designAssetMeta, setDesignAssetMeta] = React.useState<{ w: number; h: number } | null>(null);
  const [saveTemplateOpen, setSaveTemplateOpen] = React.useState(false);
  const [templateName, setTemplateName] = React.useState("");
  const [rendering, setRendering] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  // Load or initialize the editing session for this design+mockup pair.
  const sessionKey = `${designId}:${mockupId}`;
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [d, m, existing] = await Promise.all([
        db.designs.get(designId),
        db.mockups.get(mockupId),
        getPlacement(designId, mockupId),
      ]);
      if (cancelled || !d || !m) return;
      let designAssetId = d.originalAssetId;
      if (existing) designAssetId = existing.designAssetId;

      // A mockup with a print area takes its placement from the Printify
      // Studio: that is the placement the product was listed with, so the
      // mockup and the product cannot disagree. It wins over a saved
      // placement for the same reason.
      let transform: Transform = existing ? { ...existing.transform } : { ...DEFAULT_TRANSFORM };
      if (m.printArea) {
        const fromStudio = await transformFromPrintArea({
          designId,
          mockup: m,
        });
        if (fromStudio) transform = fromStudio;
      }

      const snapshot: EditorSnapshot = {
        designAssetId,
        transform,
        behindMockup: existing?.behindMockup ?? m.printArea?.clipMode === "behind-garment",
      };
      const savedSnap: EditorSnapshot | null = existing
        ? { designAssetId: existing.designAssetId, transform: { ...existing.transform }, behindMockup: existing.behindMockup ?? false }
        : null;
      init(designId, mockupId, snapshot, savedSnap);
      setReady(true);
    })();
    return () => {
      cancelled = true;
      setReady(false);
    };
  }, [sessionKey, designId, mockupId, init]);

  // Object URL for the mockup image.
  React.useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      if (!mockup) return;
      const blob = await getAssetBlob(mockup.assetId);
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setMockupUrl(url);
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setMockupUrl(null);
    };
  }, [mockup]);

  // Object URL + dimensions for the placed design asset.
  const designAssetId = current?.designAssetId ?? null;
  React.useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setDesignAssetMeta(null);
    (async () => {
      if (!designAssetId) return;
      const blob = await getAssetBlob(designAssetId);
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setDesignUrl(url);
      try {
        const bmp = await decodeImage(blob);
        if (cancelled) {
          bmp.close();
          return;
        }
        setDesignAssetMeta({ w: bmp.width, h: bmp.height });
        bmp.close();
      } catch {
        // Leave meta null; canvas will show a load error state.
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setDesignUrl(null);
    };
  }, [designAssetId]);

  React.useEffect(() => () => clear(), [clear]);

  if (!design || !mockup) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center">
          <p className="text-[13px] text-ink-muted">
            {ready ? "This design or mockup could not be found." : "Loadingâ€¦"}
          </p>
          <Button variant="outline" size="sm" className="mt-3" asChild>
            <Link href="/editor"><ArrowLeft className="h-3.5 w-3.5" /> Back to picker</Link>
          </Button>
        </div>
      </div>
    );
  }

  const variant: InkVariant =
    current?.designAssetId === design.whiteInkAssetId
      ? "white"
      : current?.designAssetId === design.blackInkAssetId
        ? "black"
        : "main";

  const handleSave = async () => {
    if (!current) return;
    // With a print area, the Studio owns the placement: saving writes the
    // new numbers back into the Studio session, for this design.
    if (mockup.printArea) {
      const session = await loadSession();
      const placement = placementForTransform({
        transform: current.transform,
        area: mockup.printArea,
        mockupW: mockup.width,
        mockupH: mockup.height,
        position: session.universalPlacement.position,
      });
      await writeBackStudioPlacement(designId, placement, session);
    } else {
      await savePlacement({
        designId,
        mockupId,
        designAssetId: current.designAssetId,
        transform: current.transform,
        behindMockup: current.behindMockup,
      });
    }
    markSaved();
    toast.success(mockup.printArea ? "Placement updated in the Printify Studio" : "Placement saved");
  };

  const handleSaveTemplate = async () => {
    if (!current || !templateName.trim()) return;
    const now = Date.now();
    const tpl: Template = {
      id: crypto.randomUUID(),
      name: templateName.trim(),
      category: "placement",
      description: `Saved from editor Â· ${design.name} on ${mockup.name}`,
      version: 1,
      payload: { type: "placement", transform: { ...current.transform } },
      createdAt: now,
      updatedAt: now,
    };
    await db.templates.put(tpl);
    await db.activity.add({
      id: crypto.randomUUID(),
      type: "template.apply",
      message: `Created placement template "${tpl.name}"`,
      createdAt: now,
    });
    toast.success(`Template "${tpl.name}" saved`);
    setSaveTemplateOpen(false);
    setTemplateName("");
  };

  const composeCurrent = async (): Promise<Blob | null> => {
    if (!current) return null;
    const [mockupBlob, designBlob] = await Promise.all([
      getAssetBlob(mockup.assetId),
      getAssetBlob(current.designAssetId),
    ]);
    if (!mockupBlob || !designBlob) {
      toast.error("Could not read the original images from storage");
      return null;
    }
    const [mockupBmp, designBmp] = await Promise.all([decodeImage(mockupBlob), decodeImage(designBlob)]);
    const canvas = document.createElement("canvas");
    // A mockup with a print area clips the design to it, exactly like the
    // product does.
    const clip = mockup.printArea
      ? clipRect(mockup.printArea.box, mockup.printArea, mockup.width, mockup.height)
      : undefined;
    const result = composeToCanvas(canvas, mockupBmp, designBmp, current.transform, {
      drawDesignFirst: current.behindMockup || mockup.printArea?.clipMode === "behind-garment",
      clip,
    });
    mockupBmp.close();
    designBmp.close();
    if (!result) return null;
    return canvasToBlob(canvas, "image/png");
  };

  const handleExportPng = async () => {
    setRendering(true);
    try {
      const blob = await composeCurrent();
      if (!blob) {
        toast.error("Rendering failed");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = sanitizeFilename(`${design.name}-${mockup.name}.png`);
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Mockup exported as PNG at full resolution");
    } finally {
      setRendering(false);
    }
  };

  const handleSaveRender = async () => {
    setRendering(true);
    try {
      const blob = await composeCurrent();
      if (!blob) {
        toast.error("Rendering failed");
        return;
      }
      await storeAsset(blob, `${design.name}-${mockup.name}.png`, "mockup-render", {
        parentId: current!.designAssetId,
        sourceDesignId: designId,
        sourceMockupId: mockupId,
      });
      toast.success("Render saved to your generated images");
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle bg-surface px-4 py-2">
        <Button variant="ghost" size="icon-sm" asChild title="Back to picker">
          <Link href="/editor"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>

        <Select
          value={designId}
          onValueChange={(v) => router.replace(`/editor?design=${v}&mockup=${mockupId}`)}
        >
          <SelectTrigger className="h-8 w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allDesigns?.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-ink-subtle">on</span>

        <Select
          value={mockupId}
          onValueChange={(v) => router.replace(`/editor?design=${designId}&mockup=${v}`)}
        >
          <SelectTrigger className="h-8 w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allMockups?.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="mx-1 h-5 w-px bg-border-subtle" />

        <Select
          value={variant}
          onValueChange={(v) => {
            const assetId =
              v === "white" ? design.whiteInkAssetId : v === "black" ? design.blackInkAssetId : design.originalAssetId;
            if (!assetId) {
              toast.error(`No ${v} ink variant for this design yet. Create one in the Design Library.`);
              return;
            }
            update({ designAssetId: assetId }, true);
          }}
        >
          <SelectTrigger className="h-8 w-[140px]" title="Ink variant to place">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="main">Main design</SelectItem>
            <SelectItem value="white" disabled={!design.whiteInkAssetId}>
              White ink {design.whiteInkAssetId ? "" : "(not created)"}
            </SelectItem>
            <SelectItem value="black" disabled={!design.blackInkAssetId}>
              Black ink {design.blackInkAssetId ? "" : "(not created)"}
            </SelectItem>
          </SelectContent>
        </Select>

        <div className="mx-1 h-5 w-px bg-border-subtle" />

        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={!canUndo} onClick={undo} title="Undo">
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={!canRedo} onClick={redo} title="Redo">
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo</TooltipContent>
          </Tooltip>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md border border-border-subtle">
            <Button variant="ghost" size="icon-sm" onClick={() => setZoom((z) => Math.max(0.2, z - 0.15))} title="Zoom out">
              <ZoomOut className="h-4 w-4" />
            </Button>
            <button
              className="min-w-[44px] text-[12px] font-medium text-ink-muted hover:text-ink"
              onClick={() => setZoom(1)}
              title="Fit to view"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button variant="ghost" size="icon-sm" onClick={() => setZoom((z) => Math.min(4, z + 0.15))} title="Zoom in">
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={!placementTemplates || placementTemplates.length === 0}>
                <TemplateIcon className="h-3.5 w-3.5" /> Template
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Apply placement template</DropdownMenuLabel>
              {placementTemplates?.map((tpl) => (
                <DropdownMenuItem
                  key={tpl.id}
                  onClick={() => {
                    if (tpl.payload.type === "placement") {
                      setTransform({ ...tpl.payload.transform }, true);
                      toast.success(`Applied template "${tpl.name}"`);
                    }
                  }}
                >
                  {tpl.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" size="sm" onClick={() => setSaveTemplateOpen(true)}>
            <Save className="h-3.5 w-3.5" /> Save as template
          </Button>

          <Button size="sm" onClick={handleSave} variant={isDirty ? "default" : "secondary"}>
            {isDirty ? <Save className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            {isDirty ? "Save" : "Saved"}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={rendering}>
                <Download className="h-3.5 w-3.5" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExportPng} disabled={rendering}>
                <FileImage /> Download PNG (full resolution)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleSaveRender} disabled={rendering}>
                <Images /> Save render to generated images
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 p-4">
          {ready && current && mockupUrl && designUrl && designAssetMeta ? (
            <EditorCanvas
              mockupUrl={mockupUrl}
              mockupW={mockup.width}
              mockupH={mockup.height}
              designUrl={designUrl}
              designW={designAssetMeta.w}
              designH={designAssetMeta.h}
              transform={current.transform}
              behindMockup={current.behindMockup}
              lockAspect={lockAspect}
              selected={selected}
              zoom={zoom}
              printArea={mockup.printArea}
              onTransformChange={(t) => setTransform(t, false)}
              onCommit={() => commit()}
              onSelect={setSelected}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border border-border-subtle bg-surface-muted/50">
              <span className="text-[13px] text-ink-muted">
                {rendering ? "Rendering at full resolutionâ€¦" : "Loading imagesâ€¦"}
              </span>
            </div>
          )}
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-subtle">
            <MoveHorizontal className="h-3 w-3" />
            Drag artwork to move Â· corner handles resize Â· anchor below rotates
            {isDirty && <Badge variant="warning" className="ml-2">unsaved changes</Badge>}
          </p>
        </div>

        <div className="w-[264px] shrink-0 border-l border-border-subtle bg-surface">
          {current && (
            <PropertiesPanel
              transform={current.transform}
              behindMockup={current.behindMockup}
              lockAspect={lockAspect}
              onTransform={(t, record) => setTransform(t, record)}
              onBehindMockup={(v) => update({ behindMockup: v }, true)}
              onLockAspect={setLockAspect}
              onReset={resetTransform}
            />
          )}
        </div>
      </div>

      {/* Save-as-template dialog */}
      <Dialog open={saveTemplateOpen} onOpenChange={setSaveTemplateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save placement as template</DialogTitle>
            <DialogDescription>
              The current position, size, rotation and flip settings can be applied to any design later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="template-name">Template name</Label>
            <Input
              id="template-name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="e.g. Center chest 35%"
              onKeyDown={(e) => e.key === "Enter" && handleSaveTemplate()}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setSaveTemplateOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!templateName.trim()} onClick={handleSaveTemplate}>
              Save template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
