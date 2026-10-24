"use client";

// ---------------------------------------------------------------------------
// The "Print areas" tab of the Mockups page.
//
// A print area maps a REAL Printify print area onto a mockup photo. It is a
// FRAME on the photo, and the design is attached to it:
//
//   * the design's placement INSIDE the area belongs to the Printify Studio
//     (where it sits, how wide, at what angle);
//   * the frame's own transform (where it sits on the photo, how big, how
//     rotated) belongs to the mockup.
//
// Moving, scaling or rotating the frame moves, scales or rotates the design
// with it, and the design is clipped to the frame - the part that falls
// outside the printable area is not on the product either.
//
// A mockup of a folded garment shows only part of that area, so the area also
// carries a CROP: a window (as fractions of the area) the design may paint
// on. The area and the print file stay whole; the mockup cuts at the fold.
//
// The area's SIZE comes from the product selected in the Printify Studio
// (the exact catalogue placeholder). The mockup's category picks the
// fallback: the typical sizes for a T-shirt, a hoodie, a mug...
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
import { emptySession, loadSession, saveSession } from "@/lib/printify/studio-session";
import { fetchVariants } from "@/lib/printify/catalog-client";
import { presetsForCategory } from "@/lib/printify/presets";
import { CATEGORY_SINGULAR } from "@/lib/mockups/categories";
import { computeFit } from "@/lib/printify/fit";
import {
  areaAspect,
  areaCrop,
  areaInches,
  defaultFrame,
  derivePrintAreas,
  designInches,
  describeCrop,
  isFullCrop,
  printAreaFromTemplate,
  printAreaOf,
  printAreaTemplateFrom,
  type AreaCrop,
  type PrintAreaOption,
} from "@/lib/mockups/print-area";
import { writeStudioPlacement } from "@/lib/mockups/resolve";
import {
  applyPrintAreaToMockups,
  printAreaScopeLabel,
  printAreaScopeTargets,
  type PrintAreaScope,
} from "@/lib/mockups/propagate";
import { resolveRenderPlan } from "@/lib/mockups/render-plan";
import { canRenderPrintFile, renderPrintFile } from "@/lib/mockups/print-file";
import { renderComposition } from "@/lib/batch/runner";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/primitives";
import type { Mockup, MockupPrintArea, StudioPlacement, StudioSession, Template } from "@/types/domain";
import { AlertTriangle, Crop, Download, ImagePlus, Layers, Loader2, Ruler, Save, Trash2 } from "lucide-react";

/** The crop windows offered as one-click presets. */
const CROP_PRESETS: Array<{ id: string; label: string; crop: AreaCrop }> = [
  { id: "top-half", label: "Top half", crop: { x: 0, y: 0, width: 1, height: 0.5 } },
  { id: "top-60", label: "Top 60%", crop: { x: 0, y: 0, width: 1, height: 0.6 } },
];

// react-konva is ~360 kB. It is loaded on demand, when the print area canvas
// actually opens, so the mockups page does not pay for it.
const PrintAreaCanvas = React.lazy(() => import("@/components/mockups/print-area-canvas"));

export function PrintAreasTab({
  initialMockupId,
}: {
  /** The mockup the page already chose (from a card's "Set the print area"). */
  initialMockupId?: string | null;
} = {}) {
  const mockups = useLiveQuery(() => db.mockups.orderBy("name").toArray(), []);
  const designs = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const templates = useLiveQuery(
    () => db.templates.where("category").equals("print-area").toArray(),
    [],
  );

  const [selectedId, setSelectedId] = React.useState<string | null>(initialMockupId ?? null);
  const [designId, setDesignId] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<StudioSession>(() => emptySession());
  const [area, setArea] = React.useState<MockupPrintArea | null>(null);
  const [designMeta, setDesignMeta] = React.useState({ assetId: "", w: 0, h: 0 });
  const [dirty, setDirty] = React.useState(false);
  const [measuring, setMeasuring] = React.useState(false);
  /** True while the canvas crops the visible window instead of staging. */
  const [cropMode, setCropMode] = React.useState(false);
  const [measuredPixels, setMeasuredPixels] = React.useState<number | null>(null);
  const [referenceInches, setReferenceInches] = React.useState("");
  const [referenceOpen, setReferenceOpen] = React.useState(false);
  const [applyTargets, setApplyTargets] = React.useState<string[]>([]);
  const [templateId, setTemplateId] = React.useState("");
  const [templateName, setTemplateName] = React.useState("");
  const [presetValue, setPresetValue] = React.useState("");
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customWidth, setCustomWidth] = React.useState("");
  const [customHeight, setCustomHeight] = React.useState("");
  /** The exact print area of the product selected in the Printify Studio. */
  const [studioArea, setStudioArea] = React.useState<PrintAreaOption | null>(null);
  /** True while the composed mockup is being written to storage. */
  const [rendering, setRendering] = React.useState(false);
  /** True while the design is being rendered onto every mockup with an area. */
  const [bulkRendering, setBulkRendering] = React.useState(false);
  /**
   * How far a frame save travels. Inside a per-design tab the workflow is
   * "place it on one photo, save, next design", so the default is every
   * mockup of the same product type; narrower or wider scopes are explicit.
   */
  const [areaScope, setAreaScope] = React.useState<PrintAreaScope>("category");
  const lastMockupId = React.useRef<string | null>(null);
  /** Bumped on every user edit, so a slow save cannot clear a newer draft. */
  const draftVersion = React.useRef(0);
  /** The debounced draft, so switching mockups cannot lose it. */
  const pendingDraft = React.useRef<{
    mockupId: string;
    area: MockupPrintArea;
    scope: PrintAreaScope;
  } | null>(null);
  const markAreaDirty = React.useCallback(() => {
    draftVersion.current += 1;
    setDirty(true);
  }, []);

  // --- session ---------------------------------------------------------------
  // Live, not one-shot: the Studio page and the Agent write the same blob, and
  // the Mockups panel must see those writes without a reload.
  const liveSession = useLiveQuery(() => loadSession(), []);
  React.useEffect(() => {
    if (liveSession) setSession(liveSession);
  }, [liveSession]);

  // --- selection -------------------------------------------------------------
  const mockup = React.useMemo(
    () => mockups?.find((m) => m.id === selectedId) ?? null,
    [mockups, selectedId],
  );

  // The design tabs are newest first, like the picker they replaced.
  const tabDesigns = React.useMemo(
    () => [...(designs ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [designs],
  );

  React.useEffect(() => {
    if (!mockups || mockups.length === 0) return;
    if (selectedId && mockups.some((m) => m.id === selectedId)) return;
    const remembered = liveSession?.mockupsActiveMockupId;
    setSelectedId(
      remembered && mockups.some((m) => m.id === remembered)
        ? remembered
        : mockups[0].id,
    );
  }, [mockups, selectedId, liveSession]);

  React.useEffect(() => {
    if (tabDesigns.length === 0) return;
    if (designId && tabDesigns.some((d) => d.id === designId)) return;
    const remembered = liveSession?.mockupsActiveDesignId;
    setDesignId(
      remembered && tabDesigns.some((d) => d.id === remembered)
        ? remembered
        : tabDesigns[0].id,
    );
  }, [tabDesigns, designId, liveSession]);

  // Remember the working tab + mockup in the session, so a reload resumes
  // the same design-by-design pass. Writes only when the selection actually
  // changed; the live query echoes the write back and this then early-returns.
  React.useEffect(() => {
    if (!liveSession) return;
    if (
      (liveSession.mockupsActiveDesignId ?? null) === designId &&
      (liveSession.mockupsActiveMockupId ?? null) === selectedId
    ) {
      return;
    }
    const next: StudioSession = { ...liveSession, updatedAt: Date.now() };
    if (designId) next.mockupsActiveDesignId = designId;
    else delete next.mockupsActiveDesignId;
    if (selectedId) next.mockupsActiveMockupId = selectedId;
    else delete next.mockupsActiveMockupId;
    void saveSession(next);
  }, [liveSession, designId, selectedId]);

  const design = React.useMemo(
    () => designs?.find((d) => d.id === designId) ?? null,
    [designs, designId],
  );

  // The mockup's saved area becomes the draft whenever the mockup changes.
  // A photo with no area starts blank: a re-save on any sibling of its type
  // is all it takes to bring it in line. The draft is auto-saved by the
  // effect below, for the scope the user chose (same type by default).
  React.useEffect(() => {
    if (!mockup) {
      setArea(null);
      setDirty(false);
      lastMockupId.current = null;
      return;
    }
    const changed = lastMockupId.current !== mockup.id;
    if (changed) {
      // Switching away from a draft that has not hit its debounce yet: write
      // it against the OLD mockup before the new one replaces it.
      const pending = pendingDraft.current;
      if (pending && pending.mockupId !== mockup.id) {
        pendingDraft.current = null;
        void applyPrintAreaToMockups({
          sourceMockupId: pending.mockupId,
          area: pending.area,
          scope: pending.scope,
        });
      }
      lastMockupId.current = mockup.id;
      setMeasuredPixels(null);
      setReferenceInches("");
      setReferenceOpen(false);
      setCropMode(false);
    } else if (dirty) {
      // The live query brought back the record this panel just saved. Do not
      // overwrite the draft the user is editing.
      return;
    }

    setArea(printAreaOf(mockup) ?? null);
    setDirty(false);
  }, [mockup, dirty]);

  // The Studio placement for the picked design. Each design owns its
  // placement; every mockup uses it inside that mockup's own frame.
  const placement = React.useMemo<StudioPlacement | null>(() => {
    if (!designId) return null;
    return session.placements[designId] ?? session.universalPlacement;
  }, [designId, session.universalPlacement, session.placements]);

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

  // --- the Studio's exact print area -----------------------------------------
  React.useEffect(() => {
    const blueprintId = session.blueprintId;
    const printProviderId = session.printProviderId;
    if (!blueprintId || !printProviderId) {
      setStudioArea(null);
      return;
    }
    let cancelled = false;
    void fetchVariants(blueprintId, printProviderId)
      .then((variants) => {
        if (cancelled) return;
        const areas = derivePrintAreas(variants);
        const wanted = session.universalPlacement.position;
        setStudioArea(areas.find((a) => a.position === wanted) ?? areas[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setStudioArea(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session.blueprintId, session.printProviderId, session.universalPlacement.position]);

  // --- the area --------------------------------------------------------------
  const mockupW = mockup?.width ?? 0;
  const mockupH = mockup?.height ?? 0;
  const categoryPresets = React.useMemo(
    () => (mockup ? presetsForCategory(mockup.category) : []),
    [mockup],
  );

  /** Creates the area with a size, keeping the frame where it is. */
  const applyAreaSize = (next: {
    areaWidth: number;
    areaHeight: number;
    label: string;
    source: MockupPrintArea["source"];
  }) => {
    if (!mockup) return;
    const frame = area?.frame ?? defaultFrame(next, mockupW, mockupH);
    setArea({
      areaWidth: next.areaWidth,
      areaHeight: next.areaHeight,
      label: next.label,
      source: next.source,
      frame,
      crop: area?.crop,
      reference: area?.reference,
      clipMode: area?.clipMode ?? "area",
      updatedAt: Date.now(),
    });
    markAreaDirty();
  };

  /**
   * Sets the visible window into the area.
   *
   * `undefined` is the whole area, and a window that covers everything is
   * stored as `undefined` too, so an untouched area never carries a crop.
   */
  const applyCrop = (crop: AreaCrop | undefined) => {
    if (!area) return;
    setArea({
      ...area,
      crop: crop && !isFullCrop(crop) ? crop : undefined,
      updatedAt: Date.now(),
    });
    markAreaDirty();
  };

  /**
   * Writes the draft to every mockup in the chosen scope, in one transaction.
   *
   * The frame is stored as fractions of the photo, so the same numbers are the
   * same relative spot on every mockup of the product type. Crop and reference
   * are deliberately preserved per photo: a folded shirt and a flat-lay need
   * different visible windows even when the design sits in the same place.
   */
  const persistArea = React.useCallback(
    async (
      next: MockupPrintArea,
      opts: { notify?: boolean; scope?: PrintAreaScope } = {},
    ): Promise<{ updated: number; mockupIds: string[] }> => {
      if (!mockup) return { updated: 0, mockupIds: [] };
      const scope = opts.scope ?? areaScope;
      const version = draftVersion.current;
      try {
        const result = await applyPrintAreaToMockups({
          sourceMockupId: mockup.id,
          area: next,
          scope,
        });
        // Only clear the draft if the user has not edited again while the
        // transaction was running.
        if (draftVersion.current === version) setDirty(false);
        if (opts.notify) {
          toast.success(
            result.updated <= 1
              ? `Print area saved on "${mockup.name}"`
              : `Print area saved on ${result.updated} mockups`,
            // One toast, not a stack: repeated saves are the same event and
            // used to leave two identical notifications on screen.
            { id: "print-area-saved" },
          );
        }
        return result;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The print area could not be saved",
        );
        return { updated: 0, mockupIds: [] };
      }
    },
    [mockup, areaScope],
  );

  // Auto-save the draft. It is debounced (a drag writes once) and uses the
  // chosen scope: every mockup of this type by default, so one save per
  // design is enough before moving to the next tab.
  React.useEffect(() => {
    if (!dirty || !mockup || !area) return;
    pendingDraft.current = { mockupId: mockup.id, area, scope: areaScope };
    const handle = setTimeout(() => {
      pendingDraft.current = null;
      void persistArea(area);
    }, 700);
    return () => clearTimeout(handle);
  }, [dirty, area, mockup, areaScope, persistArea]);

  // A full navigation can unmount the panel before the debounce fires. Kick
  // the pending write so leaving the page does not discard the last drag.
  React.useEffect(
    () => () => {
      const pending = pendingDraft.current;
      if (!pending) return;
      pendingDraft.current = null;
      void applyPrintAreaToMockups({
        sourceMockupId: pending.mockupId,
        area: pending.area,
        scope: pending.scope,
      });
    },
    [],
  );

  /** The exact print area of the product selected in the Printify Studio. */
  const useStudioArea = () => {
    if (!studioArea || !session.blueprintId || !session.printProviderId) {
      toast.info("The Printify Studio has no product selected yet.");
      return;
    }
    applyAreaSize({
      areaWidth: studioArea.width,
      areaHeight: studioArea.height,
      label: `${studioArea.position}${studioArea.method ? ` (${studioArea.method})` : ""}`,
      source: {
        kind: "studio",
        blueprintId: session.blueprintId,
        printProviderId: session.printProviderId,
        position: studioArea.position,
        method: studioArea.method,
      },
    });
    toast.success(`Using the Studio's print area (${studioArea.width}×${studioArea.height})`);
  };

  const applyPreset = (presetId: string) => {
    const preset = categoryPresets.find((p) => p.id === presetId);
    if (!preset) return;
    applyAreaSize({
      areaWidth: preset.width,
      areaHeight: preset.height,
      label: preset.label,
      source: { kind: "preset", presetId: preset.id },
    });
    setPresetValue("");
  };

  const useManualSize = () => {
    const w = Number(customWidth);
    const h = Number(customHeight);
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

  const saveArea = async () => {
    if (!mockup || !area) return;
    await persistArea(area, { notify: true });
  };

  const removeArea = async () => {
    if (!mockup) return;
    await clearPrintArea(mockup.id);
    setArea(null);
    setDirty(false);
    toast.success("Print area removed");
  };

  // --- the Studio's placement ------------------------------------------------
  const commitPlacement = async (next: StudioPlacement) => {
    if (!designId) return;
    const current = session.placements[designId] ?? session.universalPlacement;
    const unchanged =
      current.x === next.x &&
      current.y === next.y &&
      current.scale === next.scale &&
      current.angle === next.angle;
    if (unchanged) return;
    // One placement per design. This button changes the picked design only.
    const updated = await writeStudioPlacement(designId, next, { scope: "design" });
    setSession(updated);
  };

  const fitToArea = () => {
    if (!area || !placement || designMeta.w <= 0) return;
    const fit = computeFit({
      artworkWidth: designMeta.w,
      artworkHeight: designMeta.h,
      areaWidth: area.areaWidth,
      areaHeight: area.areaHeight,
    });
    void commitPlacement({ ...placement, scale: fit.scale });
  };

  /**
   * Makes this the mockup's placeholder for EVERY design.
   *
   * The per-design overrides in the Studio session are dropped, so every
   * design lands in the same spot inside this area.
   */
  const setAsPlaceholder = async () => {
    const next: StudioSession = {
      ...session,
      // Promote the placement on screen, not whatever the old fallback
      // happened to be: "this is the placeholder" must mean THIS one.
      universalPlacement: placement ? { ...placement } : session.universalPlacement,
      // Clearing the per-design entries makes this the default every design
      // starts from, so an old override cannot resurface.
      placements: {},
      updatedAt: Date.now(),
    };
    await saveSession(next);
    setSession(next);
    toast.success("Every design now uses the same placement in this area");
  };

  // --- the reference ---------------------------------------------------------
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
    markAreaDirty();
    setMeasuredPixels(null);
    toast.success("Garment reference saved");
  };

  const clearReference = () => {
    if (!area) return;
    const { reference: _removed, ...rest } = area;
    setArea(rest);
    markAreaDirty();
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

  // --- the print file --------------------------------------------------------
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

  // --- the mockup render -----------------------------------------------------
  /**
   * Composes the design onto the mockup and stores the result as a generated
   * image.
   *
   * This is where the Export Center gets its `mockup-render` assets now that
   * the editor and the batch screen are gone. It calls the SAME
   * `renderComposition` the agent's `create_mockup_render` tool calls, so a
   * render saved here and one generated by the agent are pixel-identical -
   * and both are clipped to the print area, which is the part the product
   * actually prints.
   */
  const saveRender = async () => {
    if (!design || !mockup || !area || !placement) {
      toast.info("Pick a design, a mockup and a print area first.");
      return;
    }
    setRendering(true);
    try {
      // Resolve transform AND clip from the same draft the canvas is showing.
      // renderComposition receives both, so it cannot re-read a saved area that
      // is one edit behind the preview.
      const plan = await resolveRenderPlan({
        designId: design.id,
        mockup,
        session,
        areaOverride: area,
        behindMockup: area.clipMode === "behind-garment",
      });
      await renderComposition({
        designId: design.id,
        mockupId: mockup.id,
        designAssetId: designMainAssetId(design),
        transform: plan.transform,
        clip: plan.clip ?? null,
        behindMockup: plan.behindMockup,
      });
      await logActivity("batch.item", `Rendered "${design.name}" on "${mockup.name}"`);
      toast.success("Mockup render saved — find it in the Export Center");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The mockup could not be rendered");
    } finally {
      setRendering(false);
    }
  };

  /**
   * Renders THIS design onto every mockup that has a print area.
   *
   * This is the payoff of the per-design tabs: place the design once, save,
   * and one click produces the whole set. Mockups without an area are skipped
   * rather than failing the run — they simply have nothing to paint on yet.
   * Each target resolves through the SAME render plan as the preview, so
   * these renders are pixel-identical to what the panel shows.
   */
  const renderEverywhere = async () => {
    if (!design || !mockups) return;
    const targets = mockups.filter((m) => printAreaOf(m));
    if (targets.length === 0) {
      toast.info("No mockup has a print area yet. Set one first.");
      return;
    }
    setBulkRendering(true);
    let done = 0;
    let failed = 0;
    try {
      for (const target of targets) {
        try {
          const plan = await resolveRenderPlan({
            designId: design.id,
            mockup: target,
            session,
            // The mockup on screen renders from its unsaved draft, exactly
            // like the single Save render; the rest use their saved areas.
            areaOverride: target.id === mockup?.id ? area : undefined,
          });
          await renderComposition({
            designId: design.id,
            mockupId: target.id,
            designAssetId: designMainAssetId(design),
            transform: plan.transform,
            clip: plan.clip ?? null,
            behindMockup: plan.behindMockup,
          });
          done += 1;
        } catch {
          failed += 1;
        }
      }
      if (done > 0) {
        await logActivity(
          "batch.item",
          `Rendered "${design.name}" on ${done} mockup${done === 1 ? "" : "s"}`,
        );
      }
      const skipped = mockups.length - targets.length;
      if (skipped > 0) {
        toast.success(
          `Rendered on ${done} mockup${done === 1 ? "" : "s"} · skipped ${skipped} without a print area`,
        );
      } else if (done > 0) {
        toast.success(`Rendered on ${done} mockup${done === 1 ? "" : "s"}`);
      }
      if (failed > 0) {
        toast.error(`${failed} render${failed === 1 ? "" : "s"} failed`);
      }
    } finally {
      setBulkRendering(false);
    }
  };

  // --- readouts --------------------------------------------------------------
  const physical = area ? areaInches(area, mockupW, mockupH) : null;
  const scopeCount =
    mockup && mockups ? printAreaScopeTargets(mockups, mockup, areaScope).length : 0;
  const designSize =
    area && placement && designMeta.w > 0
      ? designInches(placement.scale, designMeta.h / designMeta.w, area, mockupW, mockupH)
      : null;

  const sourceLabel = (() => {
    const source = area?.source;
    if (!source) return "";
    if (source.kind === "studio") return `The Studio's product · ${source.position}`;
    if (source.kind === "preset") {
      return categoryPresets.find((p) => p.id === source.presetId)?.label ?? "Preset";
    }
    return "Custom";
  })();

  /** The window into the area: the whole area unless it has been cropped. */
  const crop = areaCrop(area ?? {});

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
            const mArea = printAreaOf(m);
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
                    {m.width}×{m.height} · {CATEGORY_SINGULAR[m.category]}
                  </div>
                  {mArea ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-[10px]">
                        {mArea.areaWidth}×{mArea.areaHeight}
                      </Badge>
                      {mArea.reference ? (
                        <Badge variant="muted" className="text-[10px]">
                          ref {mArea.reference.inches} in
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
        {/* The per-design tabs: one tab per design, newest first. Everything
            below - the canvas, the frame, the renders - is THAT design only,
            and it shows the placement the Printify Studio uses for it. Save
            on one mockup, move to the next tab. */}
        {tabDesigns.length === 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-ink-muted">
              Upload a design in the Printify Studio to place it on a mockup.
            </span>
          </div>
        ) : (
          <div className="mb-3 flex items-end gap-2 border-b border-border-subtle">
            <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" id="design-tabs">
              {tabDesigns.map((d) => {
                const active = d.id === designId;
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDesignId(d.id)}
                    className={`whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors ${
                      active
                        ? "border-forest text-forest"
                        : "border-transparent text-ink-muted hover:text-ink"
                    }`}
                  >
                    {d.name}
                  </button>
                );
              })}
            </div>
            <Badge variant="outline" className="mb-1.5 shrink-0">
              from Printify Studio
            </Badge>
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {design ? (
            <span className="text-[12px] text-ink-subtle">
              {design.name} · its placement is used on every mockup, and by the Studio
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={fitToArea} disabled={!area || !design}>
              Fit to area
            </Button>
            {area ? (
              <Button size="sm" variant="ghost" onClick={removeArea} title="Remove the print area">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={saveArea}
              disabled={!area}
              title={`Save and apply to ${printAreaScopeLabel(areaScope).toLowerCase()}`}
            >
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
                cropMode={cropMode}
                onAreaChange={(next) => {
                  setArea(next);
                  markAreaDirty();
                }}
                onCropChange={applyCrop}
                onMeasure={(pixels) => {
                  setMeasuredPixels(pixels);
                  setMeasuring(false);
                  setReferenceOpen(true);
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

              {area ? (
                <div className="mb-3 space-y-1 text-[12px]">
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
                    <span className="text-ink-muted">From</span>
                    <span className="font-medium">{sourceLabel}</span>
                  </div>
                </div>
              ) : null}

              {area ? (
                <div className="mb-3">
                  <Label htmlFor="area-scope" className="text-[11px] text-ink-muted">
                    Apply this area to
                  </Label>
                  <Select
                    value={areaScope}
                    onValueChange={(value) =>
                      setAreaScope(value === "this" ? "this" : value === "all" ? "all" : "category")
                    }
                  >
                    <SelectTrigger id="area-scope" className="mt-1 h-8 w-full text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="this">This mockup only</SelectItem>
                      <SelectItem value="category">
                        All {mockup ? CATEGORY_SINGULAR[mockup.category] : "same-type"} mockups
                      </SelectItem>
                      <SelectItem value="all">All mockups</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[10.5px] text-ink-subtle">
                    {scopeCount} mockup{scopeCount === 1 ? "" : "s"} · {printAreaScopeLabel(areaScope)}.
                    Crop and reference stay per photo.
                  </p>
                </div>
              ) : null}

              {/* The visible window: a folded shirt shows only part of the
                  area, so the design is cut at the fold. */}
              {area ? (
                <div className="mb-3 rounded-md border border-border-subtle p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[11.5px] font-medium">
                      <Crop className="h-3 w-3" /> Visible window
                    </span>
                    <span className="text-[11px] text-ink-subtle">{describeCrop(crop)}</span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    <Button
                      size="sm"
                      variant={cropMode ? "default" : "outline"}
                      className="h-7 px-2 text-[11.5px]"
                      onClick={() => setCropMode((on) => !on)}
                      title="Drag the window and its handles on the mockup"
                    >
                      {cropMode ? "Done" : "Crop"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11.5px]"
                      onClick={() => applyCrop(undefined)}
                      disabled={isFullCrop(crop)}
                    >
                      Whole area
                    </Button>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    {CROP_PRESETS.map((preset) => (
                      <Button
                        key={preset.id}
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11.5px]"
                        onClick={() => {
                          applyCrop(preset.crop);
                          setCropMode(true);
                        }}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10.5px] leading-snug text-ink-subtle">
                    A window into the area for folded garments: the design is cut at the fold. The
                    area and the print file are not changed.
                  </p>
                </div>
              ) : null}

              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={useStudioArea}
                disabled={!studioArea}
                title={
                  studioArea
                    ? `The exact print area of the product selected in the Printify Studio`
                    : "The Printify Studio has no product selected"
                }
              >
                {studioArea
                  ? `Use the Studio's area (${studioArea.width}×${studioArea.height})`
                  : "No product selected in the Studio"}
              </Button>

              <div className="mt-2">
                <Label className="text-[11px] text-ink-muted">
                  Typical size for a {mockup ? CATEGORY_SINGULAR[mockup.category] : "mockup"}
                </Label>
                <Select
                  value={presetValue}
                  onValueChange={(v) => {
                    if (v === "") return;
                    if (v === "custom") {
                      setCustomOpen(true);
                      return;
                    }
                    applyPreset(v);
                  }}
                >
                  <SelectTrigger id="area-preset" className="h-8 w-full">
                    <SelectValue placeholder="Pick a size…" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryPresets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label} · {preset.width}×{preset.height}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">Custom size…</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {customOpen ? (
                <div className="mt-2 space-y-2">
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Label htmlFor="manual-w" className="text-[11px] text-ink-muted">
                        Width px
                      </Label>
                      <Input
                        id="manual-w"
                        value={customWidth}
                        onChange={(e) => setCustomWidth(e.target.value)}
                        placeholder="4500"
                        className="h-8"
                        inputMode="numeric"
                      />
                    </div>
                    <div className="flex-1">
                      <Label htmlFor="manual-h" className="text-[11px] text-ink-muted">
                        Height px
                      </Label>
                      <Input
                        id="manual-h"
                        value={customHeight}
                        onChange={(e) => setCustomHeight(e.target.value)}
                        placeholder="5400"
                        className="h-8"
                        inputMode="numeric"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={useManualSize}>
                      Use this size
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCustomOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}

              {area ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 w-full"
                  onClick={setAsPlaceholder}
                  title="Every design on this mockup lands in the same spot inside this area"
                >
                  Set as the placeholder for all designs
                </Button>
              ) : null}
            </Card>

            <Card className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
                  Garment reference
                </h4>
                {!referenceOpen ? (
                  <Button size="sm" variant="ghost" onClick={() => setReferenceOpen(true)}>
                    <Ruler className="h-3.5 w-3.5" /> Measure
                  </Button>
                ) : null}
              </div>
              {referenceOpen ? (
                <div className="space-y-2">
                  <p className="text-[11.5px] leading-relaxed text-ink-subtle">
                    Optional. Draw a line across the garment, type its real width in inches, and the
                    app can tell you the printed size.
                  </p>
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
                    </div>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setMeasuring((v) => !v)}
                    disabled={!area}
                  >
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
                      <div className="flex gap-2">
                        <Button size="sm" onClick={saveReference}>
                          Save reference
                        </Button>
                        {area?.reference ? (
                          <Button size="sm" variant="ghost" onClick={clearReference}>
                            Clear
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>

            <Card className="p-3">
              <h4 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
                Compositing
              </h4>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant={area?.clipMode === "behind-garment" ? "outline" : "default"}
                  disabled={!area}
                  onClick={() => {
                    if (!area) return;
                    setArea({ ...area, clipMode: "area" });
                    markAreaDirty();
                  }}
                >
                  Clip to area
                </Button>
                <Button
                  size="sm"
                  variant={area?.clipMode === "behind-garment" ? "default" : "outline"}
                  disabled={!area}
                  onClick={() => {
                    if (!area) return;
                    setArea({ ...area, clipMode: "behind-garment" });
                    markAreaDirty();
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
              <Select value={templateId} onValueChange={(v) => setTemplateId(v)}>
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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveRender}
                  disabled={!area || !design || rendering}
                >
                  {rendering ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ImagePlus className="h-3.5 w-3.5" />
                  )}
                  Save render
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={renderEverywhere}
                  disabled={!design || bulkRendering}
                  title={`Render "${design?.name ?? "this design"}" on every mockup that has a print area`}
                >
                  {bulkRendering ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Layers className="h-3.5 w-3.5" />
                  )}
                  Render on every mockup
                </Button>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-subtle">
                A template carries the area and the frame as a fraction of the photo. Tick mockups on
                the left to apply it to them. <strong className="font-medium text-ink-muted">Save
                render</strong> stores the composed mockup for the Export Center, and{" "}
                <strong className="font-medium text-ink-muted">Render on every mockup</strong> does
                the whole set for this design in one pass.
              </p>
            </Card>

            {session.blueprintId && area?.source.kind === "studio" &&
            area.source.blueprintId !== session.blueprintId ? (
              <div className="flex items-start gap-2 rounded-md bg-warning-soft p-2.5 text-[12px] leading-relaxed text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  This area came from a different product than the one selected in the Printify
                  Studio — the mockup would not match the product you actually list.
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
// The stage: the mockup, its frame, and the design inside it.
// ---------------------------------------------------------------------------

function MockupStage({
  mockup,
  area,
  placement,
  designMeta,
  measuring,
  cropMode,
  onAreaChange,
  onCropChange,
  onMeasure,
}: {
  mockup: Mockup;
  area: MockupPrintArea | null;
  placement: StudioPlacement | null;
  designMeta: { assetId: string; w: number; h: number };
  measuring: boolean;
  cropMode: boolean;
  onAreaChange: (area: MockupPrintArea) => void;
  onCropChange: (crop: AreaCrop | undefined) => void;
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
    <React.Suspense
      fallback={
        <Card className="grid min-h-[420px] place-items-center text-[13px] text-ink-muted">
          Loading the canvas…
        </Card>
      }
    >
      <PrintAreaCanvas
        mockupUrl={mockupUrl}
        mockupW={mockup.width}
        mockupH={mockup.height}
        designUrl={designUrl}
        designW={designMeta.w}
        designH={designMeta.h}
        area={area}
        placement={placement}
        measuring={measuring}
        cropMode={cropMode}
        onAreaChange={onAreaChange}
        onCropChange={onCropChange}
        onMeasure={onMeasure}
      />
    </React.Suspense>
  );
}
