"use client";

// ---------------------------------------------------------------------------
// The "Print areas" tab of the Mockups page.
//
// A print area maps a REAL Printify print area onto a mockup photo. The box
// on the photo has that area's pixel size and its exact shape; the design
// inside it is placed by the Printify Studio, so the mockup shows what the
// product gets.
//
// The Studio is the single source of truth for the design's placement:
// dragging the design here writes back into the Studio session, for that one
// design, so the mockup and the listing can never disagree.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import {
  clearPrintArea,
  designMainAssetId,
  getAssetBlob,
  logActivity,
  savePrintArea,
  uid,
} from "@/lib/db/repo";
import { emptySession, loadSession } from "@/lib/printify/studio-session";
import { fetchBlueprints, fetchProviders, fetchVariants } from "@/lib/printify/catalog-client";
import { PRINT_AREA_PRESETS, findPrintAreaPreset } from "@/lib/printify/presets";
import { computeFit } from "@/lib/printify/fit";
import {
  areaAspect,
  areaInches,
  defaultBox,
  derivePrintAreas,
  designInches,
  printAreaFromTemplate,
  printAreaTemplateFrom,
  type PrintAreaOption,
} from "@/lib/mockups/print-area";
import { writeBackStudioPlacement } from "@/lib/mockups/resolve";
import { canRenderPrintFile, renderPrintFile } from "@/lib/mockups/print-file";
import { PrintAreaEditor } from "@/components/mockups/print-area-editor";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/primitives";
import type { Mockup, MockupPrintArea, StudioPlacement, StudioSession, Template } from "@/types/domain";
import { AlertTriangle, Download, Ruler, Save, Trash2 } from "lucide-react";

const NONE = "__none__";

export function PrintAreasTab() {
  const mockups = useLiveQuery(() => db.mockups.orderBy("name").toArray(), []);
  const designs = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const templates = useLiveQuery(
    () => db.templates.where("category").equals("print-area").toArray(),
    [],
  );

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [designId, setDesignId] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<StudioSession>(() => emptySession());
  const [area, setArea] = React.useState<MockupPrintArea | null>(null);
  const [placement, setPlacement] = React.useState<StudioPlacement | null>(null);
  const [designMeta, setDesignMeta] = React.useState({ assetId: "", w: 0, h: 0 });
  const [dirty, setDirty] = React.useState(false);
  const [measuring, setMeasuring] = React.useState(false);
  const [measuredPixels, setMeasuredPixels] = React.useState<number | null>(null);
  const [referenceInches, setReferenceInches] = React.useState("");
  const [applyTargets, setApplyTargets] = React.useState<string[]>([]);
  const [templateId, setTemplateId] = React.useState("");
  const [templateName, setTemplateName] = React.useState("");
  const [presetValue, setPresetValue] = React.useState(NONE);
  const [areaPosition, setAreaPosition] = React.useState(NONE);

  // --- catalogue -------------------------------------------------------------
  const [blueprints, setBlueprints] = React.useState<{ id: number; title: string }[]>([]);
  const [blueprintFilter, setBlueprintFilter] = React.useState("");
  const [blueprintId, setBlueprintId] = React.useState<string>("");
  const [providers, setProviders] = React.useState<{ id: number; title: string }[]>([]);
  const [providerId, setProviderId] = React.useState<string>("");
  const [variants, setVariants] = React.useState<Awaited<ReturnType<typeof fetchVariants>>>([]);

  // --- session ---------------------------------------------------------------
  React.useEffect(() => {
    let cancelled = false;
    void loadSession().then((stored) => {
      if (!cancelled) setSession(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- selection -------------------------------------------------------------
  const mockup = React.useMemo(
    () => mockups?.find((m) => m.id === selectedId) ?? null,
    [mockups, selectedId],
  );

  React.useEffect(() => {
    if (!mockups || mockups.length === 0) return;
    if (selectedId && mockups.some((m) => m.id === selectedId)) return;
    setSelectedId(mockups[0].id);
  }, [mockups, selectedId]);

  React.useEffect(() => {
    if (!designs || designs.length === 0) return;
    if (designId && designs.some((d) => d.id === designId)) return;
    setDesignId(designs[0].id);
  }, [designs, designId]);

  const design = React.useMemo(
    () => designs?.find((d) => d.id === designId) ?? null,
    [designs, designId],
  );

  // The mockup's saved area becomes the draft whenever the mockup changes.
  React.useEffect(() => {
    setArea(mockup?.printArea ?? null);
    setDirty(false);
    setMeasuredPixels(null);
    setReferenceInches("");
  }, [mockup?.id, mockup?.printArea]);

  // The Studio placement for the picked design.
  React.useEffect(() => {
    if (!designId) {
      setPlacement(null);
      return;
    }
    const next = session.universal
      ? session.universalPlacement
      : (session.placements[designId] ?? session.universalPlacement);
    setPlacement({ ...next });
  }, [designId, session.universal, session.universalPlacement, session.placements]);

  // The artwork's pixel size, needed for the fit maths and the physical size.
  React.useEffect(() => {
    if (!design) {
      setDesignMeta({ assetId: "", w: 0, h: 0 });
      return;
    }
    let cancelled = false;
    const assetId = designMainAssetId(design);
    void db.assets.get(assetId).then((asset) => {
      if (cancelled) return;
      setDesignMeta({ assetId, w: asset?.width ?? 0, h: asset?.height ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [design]);

  // --- catalogue loading -----------------------------------------------------
  React.useEffect(() => {
    let cancelled = false;
    void fetchBlueprints()
      .then((list) => {
        if (cancelled) return;
        setBlueprints(list.map((b) => ({ id: b.id, title: b.title })));
      })
      .catch(() => {
        if (!cancelled) setBlueprints([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!blueprintId) {
      setProviders([]);
      return;
    }
    let cancelled = false;
    void fetchProviders(Number(blueprintId))
      .then((list) => {
        if (!cancelled) setProviders(list.map((p) => ({ id: p.id, title: p.title })));
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [blueprintId]);

  React.useEffect(() => {
    if (!blueprintId || !providerId) {
      setVariants([]);
      return;
    }
    let cancelled = false;
    void fetchVariants(Number(blueprintId), Number(providerId))
      .then((list) => {
        if (!cancelled) setVariants(list);
      })
      .catch(() => {
        if (!cancelled) setVariants([]);
      });
    return () => {
      cancelled = true;
    };
  }, [blueprintId, providerId]);

  const printAreas: PrintAreaOption[] = React.useMemo(() => derivePrintAreas(variants), [variants]);

  const filteredBlueprints = React.useMemo(() => {
    const q = blueprintFilter.trim().toLowerCase();
    const list = q ? blueprints.filter((b) => b.title.toLowerCase().includes(q)) : blueprints;
    // The catalogue holds thousands of blueprints; rendering them all stalls
    // the tab, so only the first matches are offered.
    return list.slice(0, 60);
  }, [blueprints, blueprintFilter]);

  // --- area helpers ----------------------------------------------------------
  const mockupW = mockup?.width ?? 0;
  const mockupH = mockup?.height ?? 0;

  const applyAreaSize = (next: {
    areaWidth: number;
    areaHeight: number;
    label: string;
    source: MockupPrintArea["source"];
  }) => {
    if (!mockup) return;
    const box = area?.box ?? defaultBox(next, mockupW, mockupH);
    setArea({
      areaWidth: next.areaWidth,
      areaHeight: next.areaHeight,
      label: next.label,
      source: next.source,
      box,
      reference: area?.reference,
      clipMode: area?.clipMode ?? "area",
      updatedAt: Date.now(),
    });
    setDirty(true);
  };

  const saveArea = async () => {
    if (!mockup || !area) return;
    await savePrintArea(mockup.id, area);
    setDirty(false);
    toast.success(`Print area saved on "${mockup.name}"`);
  };

  const removeArea = async () => {
    if (!mockup) return;
    await clearPrintArea(mockup.id);
    setArea(null);
    setDirty(false);
    toast.success("Print area removed");
  };

  // --- placement write-back --------------------------------------------------
  const commitPlacement = async (next: StudioPlacement) => {
    if (!designId) return;
    const current = session.universal
      ? session.universalPlacement
      : (session.placements[designId] ?? session.universalPlacement);
    const unchanged =
      current.x === next.x &&
      current.y === next.y &&
      current.scale === next.scale &&
      current.angle === next.angle;
    if (unchanged) return;
    const updated = await writeBackStudioPlacement(designId, next, session);
    setSession(updated);
    toast.success("Placement updated in the Printify Studio");
  };

  const fitToArea = () => {
    if (!area || !placement || designMeta.w <= 0) return;
    const fit = computeFit({
      artworkWidth: designMeta.w,
      artworkHeight: designMeta.h,
      areaWidth: area.areaWidth,
      areaHeight: area.areaHeight,
    });
    const next = { ...placement, scale: fit.scale };
    setPlacement(next);
    void commitPlacement(next);
  };

  const matchStudioBlueprint = () => {
    if (!session.blueprintId) {
      toast.info("The Printify Studio has no product selected yet.");
      return;
    }
    setBlueprintId(String(session.blueprintId));
    if (session.printProviderId) setProviderId(String(session.printProviderId));
    toast.info("Blueprint matched. Pick the print area to use it.");
  };

  const applyPrintifyArea = (position: string) => {
    const option = printAreas.find((p) => p.position === position);
    if (!option || !blueprintId || !providerId) return;
    applyAreaSize({
      areaWidth: option.width,
      areaHeight: option.height,
      label: `${option.position}${option.method ? ` (${option.method})` : ""}`,
      source: {
        kind: "printify",
        blueprintId: Number(blueprintId),
        printProviderId: Number(providerId),
        position: option.position,
      },
    });
    setAreaPosition(NONE);
  };

  const applyPreset = (presetId: string) => {
    const preset = findPrintAreaPreset(presetId);
    if (!preset) return;
    applyAreaSize({
      areaWidth: preset.width,
      areaHeight: preset.height,
      label: preset.label,
      source: { kind: "preset", presetId: preset.id },
    });
    setPresetValue(NONE);
  };

  const useManualSize = (width: string, height: string) => {
    const w = Number(width);
    const h = Number(height);
    if (!w || !h) {
      toast.error("Enter a width and a height in pixels.");
      return;
    }
    applyAreaSize({
      areaWidth: w,
      areaHeight: h,
      label: "Custom area",
      source: { kind: "manual" },
    });
  };

  // --- reference -------------------------------------------------------------
  const saveReference = () => {
    if (!area || !measuredPixels || !referenceInches) return;
    const inches = Number(referenceInches);
    if (!inches || inches <= 0) {
      toast.error("Enter the real width in inches.");
      return;
    }
    setArea({
      ...area,
      reference: {
        label: area.reference?.label ?? "Reference line",
        inches,
        pixelsPerInch: measuredPixels / inches,
      },
    });
    setDirty(true);
    setMeasuredPixels(null);
    toast.success("Garment reference saved");
  };

  const clearReference = () => {
    if (!area) return;
    const { reference: _removed, ...rest } = area;
    setArea(rest);
    setDirty(true);
    setMeasuredPixels(null);
  };

  // --- templates -------------------------------------------------------------
  const saveTemplate = async () => {
    if (!area) return;
    const name = templateName.trim() || area.label;
    const now = Date.now();
    const tpl: Template = {
      id: uid(),
      name,
      category: "print-area",
      description: `Print area · ${area.areaWidth}×${area.areaHeight}`,
      version: 1,
      payload: printAreaTemplateFrom(area),
      createdAt: now,
      updatedAt: now,
    };
    await db.templates.put(tpl);
    await logActivity("template.apply", `Saved print-area template "${name}"`);
    setTemplateName("");
    setTemplateId(tpl.id);
    toast.success(`Template "${name}" saved`);
  };

  const applyTemplate = async () => {
    const tpl = templates?.find((t) => t.id === templateId);
    if (!tpl || tpl.payload.type !== "print-area") return;
    if (applyTargets.length === 0) {
      toast.info("Tick the mockups the template should be applied to.");
      return;
    }
    for (const id of applyTargets) {
      const target = await db.mockups.get(id);
      if (!target) continue;
      await savePrintArea(id, printAreaFromTemplate(tpl.payload));
    }
    toast.success(`Applied "${tpl.name}" to ${applyTargets.length} mockup(s)`);
    setApplyTargets([]);
  };

  // --- print file ------------------------------------------------------------
  const exportPrintFile = async () => {
    if (!design || !area || !placement) {
      toast.info("Pick a design and a print area first.");
      return;
    }
    if (!canRenderPrintFile(area)) {
      toast.error("That print area is too large to render here. Use a smaller area.");
      return;
    }
    const blob = await getAssetBlob(designMainAssetId(design));
    if (!blob) {
      toast.error("The design image could not be read.");
      return;
    }
    try {
      const result = await renderPrintFile({ designBlob: blob, area, placement });
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${design.name}-${area.areaWidth}x${area.areaHeight}.png`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`Print file exported (${result.width}×${result.height})`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The print file could not be rendered");
    }
  };

  // --- readouts --------------------------------------------------------------
  const physical = area ? areaInches(area, mockupW, mockupH) : null;
  const designSize =
    area && placement && designMeta.w > 0
      ? designInches(
          placement.scale,
          designMeta.h / designMeta.w,
          area,
          mockupW,
          mockupH,
        )
      : null;

  const studioBlueprintMismatch =
    area?.source.kind === "printify" &&
    session.blueprintId !== undefined &&
    area.source.blueprintId !== session.blueprintId;

  return (
    <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-4">
      {/* --- the mockup rail --- */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <span className="text-[13px] font-semibold">Mockups</span>
          <span className="text-[11px] text-ink-subtle">{mockups?.length ?? 0}</span>
        </div>
        <div className="max-h-[640px] overflow-auto p-2">
          {(mockups ?? []).map((m) => {
            const selected = m.id === selectedId;
            return (
              <div
                key={m.id}
                className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${
                  selected ? "bg-forest-soft" : "hover:bg-surface-muted"
                }`}
              >
                <Checkbox
                  checked={applyTargets.includes(m.id)}
                  onCheckedChange={(checked) =>
                    setApplyTargets((prev) =>
                      checked ? [...prev, m.id] : prev.filter((id) => id !== m.id),
                    )
                  }
                  aria-label={`Select ${m.name}`}
                  className="mt-1"
                />
                <button type="button" onClick={() => setSelectedId(m.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[13px] font-medium">{m.name}</div>
                  <div className="text-[11px] text-ink-subtle">
                    {m.width}×{m.height}
                  </div>
                  {m.printArea ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-[10px]">
                        {m.printArea.areaWidth}×{m.printArea.areaHeight}
                      </Badge>
                      {m.printArea.reference ? (
                        <Badge variant="muted" className="text-[10px]">
                          ref {m.printArea.reference.inches} in
                        </Badge>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-1 text-[10.5px] text-ink-subtle">no area yet</div>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </Card>

      {/* --- the workspace --- */}
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Label htmlFor="area-design" className="text-[12px] text-ink-muted">
            Design
          </Label>
          <Select value={designId ?? NONE} onValueChange={(v) => setDesignId(v === NONE ? null : v)}>
            <SelectTrigger id="area-design" className="h-8 w-[220px]">
              <SelectValue placeholder="Pick a design" />
            </SelectTrigger>
            <SelectContent>
              {(designs ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant="outline">from Printify Studio</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={matchStudioBlueprint}>
              Match Studio blueprint
            </Button>
            <Button size="sm" variant="outline" onClick={fitToArea} disabled={!area || !design}>
              Fit to area
            </Button>
            {area ? (
              <Button size="sm" variant="ghost" onClick={removeArea} title="Remove the print area">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <Button size="sm" onClick={saveArea} disabled={!area || !dirty} title="Save the print area">
              <Save className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4">
          <div className="min-w-0">
            {mockup ? (
              <MockupStage
                mockup={mockup}
                area={area}
                placement={placement}
                designMeta={designMeta}
                measuring={measuring}
                onAreaChange={(next) => {
                  setArea(next);
                  setDirty(true);
                }}
                onPlacementChange={setPlacement}
                onPlacementCommit={(next) => void commitPlacement(next)}
                onMeasure={(pixels) => {
                  setMeasuredPixels(pixels);
                  setMeasuring(false);
                }}
              />
            ) : (
              <Card className="p-8 text-center text-[13px] text-ink-muted">
                Upload a mockup to set a print area on it.
              </Card>
            )}
          </div>

          {/* --- the controls --- */}
          <div className="flex flex-col gap-3">
            <Card className="p-3">
              <h4 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
                Print area
              </h4>

              <div className="mb-2">
                <Label htmlFor="bp-filter" className="text-[11px] text-ink-muted">
                  Printify blueprint
                </Label>
                <Input
                  id="bp-filter"
                  value={blueprintFilter}
                  onChange={(e) => setBlueprintFilter(e.target.value)}
                  placeholder="Search blueprint…"
                  className="h-8"
                />
              </div>
              <Select value={blueprintId || NONE} onValueChange={(v) => setBlueprintId(v === NONE ? "" : v)}>
                <SelectTrigger id="area-blueprint" className="h-8 w-full">
                  <SelectValue placeholder="Pick a blueprint" />
                </SelectTrigger>
                <SelectContent>
                  {filteredBlueprints.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="mt-2">
                <Select
                  value={providerId || NONE}
                  onValueChange={(v) => setProviderId(v === NONE ? "" : v)}
                  disabled={!blueprintId}
                >
                  <SelectTrigger id="area-provider" className="h-8 w-full">
                    <SelectValue placeholder="Pick a print provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="mt-2">
                <Select
                  value={areaPosition}
                  onValueChange={(v) => {
                    if (v === NONE) return;
                    applyPrintifyArea(v);
                  }}
                  disabled={printAreas.length === 0}
                >
                  <SelectTrigger id="area-source" className="h-8 w-full">
                    <SelectValue
                      placeholder={printAreas.length ? "Pick a print area" : "No areas found"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {printAreas.map((option) => (
                      <SelectItem key={option.position} value={option.position}>
                        {option.position} · {option.width}×{option.height}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="my-3 border-t border-border-subtle" />

              <div className="mb-2">
                <Label className="text-[11px] text-ink-muted">Preset</Label>
                <Select
                  value={presetValue}
                  onValueChange={(v) => {
                    if (v === NONE) return;
                    applyPreset(v);
                  }}
                >
                  <SelectTrigger id="area-preset" className="h-8 w-full">
                    <SelectValue placeholder="Use a preset…" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRINT_AREA_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label} · {preset.width}×{preset.height}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <ManualSize onApply={useManualSize} />

              {area ? (
                <div className="mt-3 space-y-1 text-[12px]">
                  <div className="flex justify-between">
                    <span className="text-ink-muted">Size</span>
                    <span className="font-medium">
                      {area.areaWidth} × {area.areaHeight} px
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-muted">Aspect</span>
                    <span className="font-medium">{areaAspect(area).toFixed(3)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-muted">Source</span>
                    <span className="font-medium">
                      {area.source.kind === "printify"
                        ? `Printify · ${area.source.position}`
                        : area.source.kind === "preset"
                          ? "Preset"
                          : "Manual"}
                    </span>
                  </div>
                </div>
              ) : null}
            </Card>

            <Card className="p-3">
              <h4 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
                Garment reference
              </h4>
              {area?.reference ? (
                <div className="space-y-1 text-[12px]">
                  <div className="flex justify-between">
                    <span className="text-ink-muted">Real width</span>
                    <span className="font-medium">{area.reference.inches} in</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-muted">Scale</span>
                    <span className="font-medium">
                      {area.reference.pixelsPerInch.toFixed(1)} px / in
                    </span>
                  </div>
                  {physical ? (
                    <div className="flex justify-between">
                      <span className="text-ink-muted">Area on shirt</span>
                      <span className="font-medium">
                        {physical.width.toFixed(1)} × {physical.height.toFixed(1)} in
                      </span>
                    </div>
                  ) : null}
                  {designSize ? (
                    <div className="flex justify-between">
                      <span className="text-ink-muted">Design prints at</span>
                      <span className="font-medium">
                        {designSize.width.toFixed(1)} × {designSize.height.toFixed(1)} in
                      </span>
                    </div>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={clearReference} className="mt-1">
                    Clear reference
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11.5px] leading-relaxed text-ink-subtle">
                    Optional. Draw a line across the garment, type its real width in inches, and the
                    app can tell you the printed size.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setMeasuring((v) => !v)}
                    disabled={!area}
                  >
                    <Ruler className="h-3.5 w-3.5" />
                    {measuring ? "Cancel measuring" : "Measure a line"}
                  </Button>
                  {measuredPixels ? (
                    <div className="space-y-2 rounded-md bg-surface-muted p-2">
                      <div className="text-[11.5px] text-ink-muted">
                        Measured {measuredPixels} px in the photo.
                      </div>
                      <Input
                        value={referenceInches}
                        onChange={(e) => setReferenceInches(e.target.value)}
                        placeholder="Real width in inches"
                        className="h-8"
                      />
                      <Button size="sm" onClick={saveReference}>
                        Save reference
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </Card>

            <Card className="p-3">
              <h4 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
                Compositing
              </h4>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant={area?.clipMode === "behind-garment" ? "outline" : "default"}
                  onClick={() => {
                    if (!area) return;
                    setArea({ ...area, clipMode: "area" });
                    setDirty(true);
                  }}
                >
                  Clip to area
                </Button>
                <Button
                  size="sm"
                  variant={area?.clipMode === "behind-garment" ? "default" : "outline"}
                  onClick={() => {
                    if (!area) return;
                    setArea({ ...area, clipMode: "behind-garment" });
                    setDirty(true);
                  }}
                >
                  Behind garment
                </Button>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-subtle">
                “Behind garment” draws the design under a transparent mockup PNG, so only the shirt
                shows it.
              </p>
            </Card>

            <Card className="p-3">
              <h4 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
                Reuse
              </h4>
              <Select value={templateId || NONE} onValueChange={(v) => setTemplateId(v === NONE ? "" : v)}>
                <SelectTrigger id="area-template" className="h-8 w-full">
                  <SelectValue placeholder="Pick a template" />
                </SelectTrigger>
                <SelectContent>
                  {(templates ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Template name"
                className="mt-2 h-8"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" onClick={saveTemplate} disabled={!area}>
                  Save as template
                </Button>
                <Button size="sm" variant="outline" onClick={applyTemplate} disabled={!templateId}>
                  Apply to selected
                </Button>
                <Button size="sm" variant="outline" onClick={exportPrintFile} disabled={!area}>
                  <Download className="h-3.5 w-3.5" /> Export print file
                </Button>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-subtle">
                A template carries the area and the box position as a fraction of the photo. Tick
                mockups on the left to apply it to them.
              </p>
            </Card>

            {studioBlueprintMismatch ? (
              <div className="flex items-start gap-2 rounded-md bg-warning-soft p-2.5 text-[12px] leading-relaxed text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  This mockup’s blueprint differs from the one selected in the Printify Studio — the
                  mockup would not match the product you actually list.
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stage: the mockup, its area, and the design inside it.
// ---------------------------------------------------------------------------

function MockupStage({
  mockup,
  area,
  placement,
  designMeta,
  measuring,
  onAreaChange,
  onPlacementChange,
  onPlacementCommit,
  onMeasure,
}: {
  mockup: Mockup;
  area: MockupPrintArea | null;
  placement: StudioPlacement | null;
  designMeta: { assetId: string; w: number; h: number };
  measuring: boolean;
  onAreaChange: (area: MockupPrintArea) => void;
  onPlacementChange: (placement: StudioPlacement) => void;
  onPlacementCommit: (placement: StudioPlacement) => void;
  onMeasure: (pixels: number) => void;
}) {
  const [mockupUrl, setMockupUrl] = React.useState<string | null>(null);
  const [designUrl, setDesignUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void getAssetBlob(mockup.assetId).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setMockupUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setMockupUrl(null);
    };
  }, [mockup.assetId]);

  React.useEffect(() => {
    if (!designMeta.assetId) {
      setDesignUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    void getAssetBlob(designMeta.assetId).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setDesignUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setDesignUrl(null);
    };
  }, [designMeta.assetId]);

  if (!mockupUrl) {
    return (
      <Card className="grid min-h-[420px] place-items-center text-[13px] text-ink-muted">
        Loading the mockup…
      </Card>
    );
  }

  return (
    <div>
      <PrintAreaEditor
        mockupUrl={mockupUrl}
        mockupW={mockup.width}
        mockupH={mockup.height}
        designUrl={designUrl}
        designW={designMeta.w}
        designH={designMeta.h}
        area={area}
        placement={placement}
        measuring={measuring}
        onAreaChange={onAreaChange}
        onPlacementChange={onPlacementChange}
        onCommit={() => {
          if (placement) onPlacementCommit(placement);
        }}
        onMeasure={onMeasure}
      />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-subtle">
        {placement ? (
          <>
            <span>
              Design <b className="text-ink">{Math.round(placement.scale * 100)}%</b> of the print
              area width
            </span>
            <span>
              Placement x {placement.x.toFixed(2)} · y {placement.y.toFixed(2)} · {placement.angle}°
            </span>
            <span>Drag the artwork to move it, its corner to resize, the round handle to rotate.</span>
          </>
        ) : (
          <span>Pick a design to place it in the area.</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The manual fallback: type the area's size.
// ---------------------------------------------------------------------------

function ManualSize({ onApply }: { onApply: (width: string, height: string) => void }) {
  const [width, setWidth] = React.useState("");
  const [height, setHeight] = React.useState("");
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <Label htmlFor="manual-w" className="text-[11px] text-ink-muted">
          Manual px
        </Label>
        <Input
          id="manual-w"
          value={width}
          onChange={(e) => setWidth(e.target.value)}
          placeholder="W"
          className="h-8"
          inputMode="numeric"
        />
      </div>
      <div className="flex-1">
        <Label htmlFor="manual-h" className="sr-only">
          Height in pixels
        </Label>
        <Input
          id="manual-h"
          value={height}
          onChange={(e) => setHeight(e.target.value)}
          placeholder="H"
          className="h-8"
          inputMode="numeric"
        />
      </div>
      <Button size="sm" variant="outline" onClick={() => onApply(width, height)}>
        Use
      </Button>
    </div>
  );
}
