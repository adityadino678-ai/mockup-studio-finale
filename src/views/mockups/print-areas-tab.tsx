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
  designMainAssetId,
  getAssetBlob,
  logActivity,
  savePrintArea,
  uid,
} from "@/lib/db/repo";
import { emptySession, loadSession, saveSession } from "@/lib/printify/studio-session";
import { findAdoptableRender } from "@/views/listings/render-adoption";
import { fetchVariants } from "@/lib/printify/catalog-client";
import { presetsForCategory } from "@/lib/printify/presets";
import { CATEGORY_SINGULAR } from "@/lib/mockups/categories";
import {
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
  seedPrintArea,
  type AreaCrop,
  type PrintAreaOption,
} from "@/lib/mockups/print-area";
import {
  applyPrintAreaToMockups,
  printAreaScopeTargets,
  type PrintAreaScope,
} from "@/lib/mockups/propagate";
import { resolveRenderPlanWithFingerprint } from "@/lib/printify/listing-render";
import { linkSavedRender } from "@/lib/printify/render-link";
import { buildStudioListings, catalogProductName } from "@/lib/printify/listing-plan";
import { saveStudioListingDrafts } from "@/lib/printify/listing-drafts";
import { isProductMockup } from "@/lib/mockups/info-cards";
import { canRenderPrintFile, renderPrintFile } from "@/lib/mockups/print-file";
import { renderComposition } from "@/lib/batch/runner";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/primitives";
import { useListingCatalog } from "@/views/listings/listing-catalog";
import type {
  Design,
  Mockup,
  MockupPrintArea,
  StudioPlacement,
  StudioSession,
  Template,
} from "@/types/domain";
import { Crop, Download, Loader2 } from "lucide-react";

/** The crop windows offered as one-click presets. */
const CROP_PRESETS: Array<{ id: string; label: string; crop: AreaCrop }> = [
  { id: "top-half", label: "Top half", crop: { x: 0, y: 0, width: 1, height: 0.5 } },
  { id: "top-60", label: "Top 60%", crop: { x: 0, y: 0, width: 1, height: 0.6 } },
];

class PrintAreaCanvasBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card className="grid min-h-[420px] place-items-center p-6 text-center">
          <div>
            <p className="text-[15px] font-bold text-ink">The print-area canvas could not load.</p>
            <p className="mt-1 text-sm text-ink-muted">
              Reload the page. If it still does not open, your mockup or design image may be missing from this browser.
            </p>
          </div>
        </Card>
      );
    }
    return this.props.children;
  }
}

// react-konva is ~360 kB. It is loaded on demand, when the print area canvas
// actually opens, so the mockups page does not pay for it.
const PrintAreaCanvas = React.lazy(() => import("@/components/mockups/print-area-canvas"));

export function PrintAreasTab({
  initialMockupId,
}: {
  /** The mockup the page already chose (from a card's "Set the print area"). */
  initialMockupId?: string | null;
} = {}) {
  // Info cards are information images, not product photos: they never get a
  // print area, so they are filtered out here and never appear in this tab.
  const mockups = useLiveQuery(
    async () =>
      (await db.mockups.orderBy("name").toArray()).filter((m) => m.kind !== "info-card"),
    [],
  );
  const designs = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const templates = useLiveQuery(
    () => db.templates.where("category").equals("print-area").toArray(),
    [],
  );

  const [selectedId, setSelectedId] = React.useState<string | null>(initialMockupId ?? null);
  const [designId, setDesignId] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<StudioSession>(() => emptySession());
  const catalog = useListingCatalog();
  const [area, setArea] = React.useState<MockupPrintArea | null>(null);
  const [designMeta, setDesignMeta] = React.useState({ assetId: "", w: 0, h: 0 });
  const [dirty, setDirty] = React.useState(false);
  const [measuring, setMeasuring] = React.useState(false);
  /** True while the canvas crops the visible window instead of staging. */
  const [cropMode, setCropMode] = React.useState(false);
  const [measuredPixels, setMeasuredPixels] = React.useState<number | null>(null);
  const [referenceInches, setReferenceInches] = React.useState("");
  const [_referenceOpen, _setReferenceOpen] = React.useState(false);
  const [applyTargets, setApplyTargets] = React.useState<string[]>([]);
  const [templateId, setTemplateId] = React.useState("");
  const [templateName, setTemplateName] = React.useState("");
  const [_presetValue, setPresetValue] = React.useState("");
  const [_customOpen, _setCustomOpen] = React.useState(false);
  const [_customWidth, _setCustomWidth] = React.useState("");
  const [_customHeight, _setCustomHeight] = React.useState("");
  /** The exact print area of the product selected in the Printify Studio. */
  const [studioArea, setStudioArea] = React.useState<PrintAreaOption | null>(null);
  /**
   * True while the background render pass for the active design is running.
   * The saves and the renders both happen on their own now - there is no
   * render button to click.
   */
  const [bulkRendering, setBulkRendering] = React.useState(false);
  /**
   * How far a frame save travels. Inside a per-design tab the workflow is
   * "place it on one photo, save, next design", so the default is every
   * mockup of the same product type; narrower or wider scopes are explicit.
   */
  const [areaScope, _setAreaScope] = React.useState<PrintAreaScope>("category");
  const lastMockupId = React.useRef<string | null>(null);
  /** The design the draft in `area` belongs to, so a tab switch reloads it. */
  const lastDesignId = React.useRef<string | null>(null);
  /** Bumped on every user edit, so a slow save cannot clear a newer draft. */
  const draftVersion = React.useRef(0);
  /** The debounced draft, so switching mockups or designs cannot lose it. */
  const pendingDraft = React.useRef<{
    mockupId: string;
    designId: string | null;
    area: MockupPrintArea;
    scope: PrintAreaScope;
  } | null>(null);
  /**
   * The mockup+design the user made the current draft on.
   *
   * A tab switch re-renders with the NEW mockup/design but the OLD `area` for
   * one commit. Without this, the debounce effect would re-arm using the old
   * draft under the new tab and a later flush would write it to the wrong
   * design. Only a user edit (`markAreaDirty`) claims a draft.
   */
  const draftOwner = React.useRef<string | null>(null);
  /**
   * The mockup+design key of an auto-seeded area that the user has not
   * touched yet. The seed is a draft, never a write: the debounced autosave
   * only arms on `dirty`, and the seed never sets it. Explicit actions that
   * promise pixels of exactly what is on screen (Save/Render) DO persist the
   * seed, so what is stored matches the preview.
   */
  const untouchedSeedRef = React.useRef<string | null>(null);
  /** The live debounce handle, so an explicit remove can cancel it. */
  const autoSaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The background render pass. Timer and effect triggers call through the
   * ref, so they always run the latest version instead of a stale closure.
   */
  const autoRenderAllRef = React.useRef<(designId: string | null) => Promise<void>>(
    async () => {},
  );
  /** A render pass is already running in the background. */
  const autoRenderBusy = React.useRef(false);
  /** The design an arriving trigger wants rendered once the pass ends. */
  const autoRenderRerun = React.useRef<string | null>(null);

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
  const activeMockupId = mockup?.id ?? null;

  /**
   * Marks the draft dirty AND records which tab it belongs to.
   *
   * `draftOwner` is what stops the debounce from treating the previous tab's
   * area as the new tab's draft on the commit where the tab changes but the
   * `area` state has not been reloaded yet.
   */
  const markAreaDirty = React.useCallback(() => {
    untouchedSeedRef.current = null;
    draftOwner.current = `${activeMockupId ?? ""}:${designId ?? ""}`;
    draftVersion.current += 1;
    setDirty(true);
  }, [activeMockupId, designId]);

  // The tabs are numbered OLDEST FIRST: tab 1 is the first uploaded design,
  // so the numbering matches the Studio's design order and the loop that
  // creates one product per design, which both walk uploads in order.
  const tabDesigns = React.useMemo(
    () => [...(designs ?? [])].sort((a, b) => a.createdAt - b.createdAt),
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
  // Read as primitives so the effect below can depend on them honestly: it
  // re-seeds when the Studio's exact area resolves.
  const studioBlueprint = session.blueprintId;
  const studioProvider = session.printProviderId;
  const categoryPresets = React.useMemo(
    () => (mockup ? presetsForCategory(mockup.category) : []),
    [mockup],
  );

  // The ACTIVE design's saved area on this mockup becomes the draft whenever
  // the mockup OR the design tab changes. Each design owns its own frame per
  // mockup: a design with no override falls back to the shared default, so a
  // fresh tab starts where every never-edited design starts. A photo with no
  // area starts blank: a re-save on any sibling of its type is all it takes to
  // bring it in line. The draft is auto-saved by the effect below, for the
  // scope the user chose (same type by default).
  React.useEffect(() => {
    if (!mockup) {
      untouchedSeedRef.current = null;
      setArea(null);
      setDirty(false);
      lastMockupId.current = null;
      lastDesignId.current = null;
      return;
    }
    const mockupChanged = lastMockupId.current !== mockup.id;
    const designChanged = lastDesignId.current !== designId;
    let justFlushed = false;
    if (mockupChanged || designChanged) {
      // Switching away from a draft that has not hit its debounce yet: write
      // it against the OLD mockup AND the old design before the new tab
      // replaces it, so a delayed flush can never land on the wrong tab.
      const pending = pendingDraft.current;
      if (
        pending &&
        (pending.mockupId !== mockup.id || pending.designId !== designId)
      ) {
        pendingDraft.current = null;
        justFlushed = true;
        void applyPrintAreaToMockups({
          sourceMockupId: pending.mockupId,
          designId: pending.designId ?? undefined,
          area: pending.area,
          scope: pending.scope,
        }).then(() => {
          // The switch was also a save, and saves render on their own now:
          // the design that just left the screen still gets its pixels.
          void autoRenderAllRef.current(pending.designId);
        });
      }
      if (mockupChanged) {
        lastMockupId.current = mockup.id;
        setMeasuredPixels(null);
        setReferenceInches("");
        _setReferenceOpen(false);
        setCropMode(false);
      }
      lastDesignId.current = designId;
    } else if (dirty) {
      // The live query brought back the record this panel just saved. Do not
      // overwrite the draft the user is editing.
      return;
    }

    const stored = printAreaOf(mockup, designId) ?? null;
    if (stored) {
      untouchedSeedRef.current = null;
      setArea(stored);
      setDirty(false);
      return;
    }
    // Nothing stored: auto-draft a pick the user can save - the Studio's
    // exact area first, the category's typical size otherwise, nothing when
    // both are unavailable or the user deliberately removed the area (a null
    // override wins over any suggestion). A seed never arms the autosave;
    // persisting it happens on explicit Save/Render. When we JUST flushed the
    // user's away-switched draft, the stored area is on its way back from
    // the write, so do not paper over it with a seed this run.
    if (justFlushed) {
      untouchedSeedRef.current = null;
      setArea(null);
      setDirty(false);
      return;
    }
    const seeded = seedPrintArea(
      mockup,
      designId,
      studioArea && studioBlueprint && studioProvider
        ? {
            width: studioArea.width,
            height: studioArea.height,
            label: `${studioArea.position}${studioArea.method ? ` (${studioArea.method})` : ""}`,
            source: {
              kind: "studio",
              blueprintId: studioBlueprint,
              printProviderId: studioProvider,
              position: studioArea.position,
              method: studioArea.method,
            },
          }
        : null,
      categoryPresets[0]
        ? {
            width: categoryPresets[0].width,
            height: categoryPresets[0].height,
            label: categoryPresets[0].label,
            source: { kind: "preset", presetId: categoryPresets[0].id },
          }
        : null,
    );
    untouchedSeedRef.current = seeded ? `${mockup.id}:${designId ?? ""}` : null;
    setArea(seeded);
    setDirty(false);
  }, [mockup, dirty, designId, studioArea, studioBlueprint, studioProvider, categoryPresets]);

  // The Studio placement for the picked design. Each design owns its
  // placement; every mockup uses it inside that mockup's own frame.
  const placement = React.useMemo<StudioPlacement | null>(() => {
    if (!designId) return null;
    return session.placements[designId] ?? session.universalPlacement;
  }, [designId, session.universalPlacement, session.placements]);

  /**
   * Rendering needs no click now: when the tab loads, when the active design
   * or its artwork changes, or when its placement moves, the background pass
   * backfills every mockup that has no render at the CURRENT fingerprint.
   * Anything already rendered is skipped, so a repeat trigger costs a
   * fingerprint computation, not a re-render.
   *
   * The pass is also held while the user is working on the canvas: a gesture
   * (drag / resize / rotate / crop / measure) sets `interactingRef`, and the
   * pass fires only after the pointer comes up. Without this, a background
   * pass would save renders and session writes MID-DRAG - re-rendering the
   * stage under the pointer and rendering at positions the user is about to
   * change.
   */
  const interactingRef = React.useRef(false);
  const autoRenderTimerRef = React.useRef<number | null>(null);
  const autoRenderPendingRef = React.useRef(false);
  const [interactTick, setInteractTick] = React.useState(0);

  const onInteractStart = React.useCallback(() => {
    interactingRef.current = true;
  }, []);

  const onInteractEnd = React.useCallback(() => {
    interactingRef.current = false;
    // A nudge in state re-arms both the auto-save and the auto-render
    // timers the gesture suppressed, from the FINAL committed values.
    setInteractTick((tick) => tick + 1);
  }, []);

  const armAutoRender = React.useCallback(() => {
    if (autoRenderTimerRef.current !== null) {
      window.clearTimeout(autoRenderTimerRef.current);
    }
    autoRenderTimerRef.current = window.setTimeout(() => {
      autoRenderTimerRef.current = null;
      if (interactingRef.current) {
        autoRenderPendingRef.current = true;
        return;
      }
      void autoRenderAllRef.current(designId);
    }, 600);
  }, [designId]);

  React.useEffect(() => {
    armAutoRender();
    return () => {
      if (autoRenderTimerRef.current !== null) {
        window.clearTimeout(autoRenderTimerRef.current);
        autoRenderTimerRef.current = null;
      }
    };
  }, [
    armAutoRender,
    interactTick,
    tabDesigns.length,
    designMeta.assetId,
    placement?.scale,
    placement?.x,
    placement?.y,
    placement?.angle,
    session.universalPlacement.scale,
    session.universalPlacement.x,
    session.universalPlacement.y,
    session.universalPlacement.angle,
  ]);

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
   * Writes the draft as the ACTIVE DESIGN's area on every mockup in the chosen
   * scope, in one transaction.
   *
   * The frame is stored as fractions of the photo, so the same numbers are the
   * same relative spot on every mockup of the product type, and the crop
   * travels with the frame - the visible window is part of the staged pose.
   * The inches reference is deliberately kept per photo: a folded shirt and a
   * flat-lay are measured differently even when the design sits in the same
   * place. Only this design's overrides are written: the shared default and
   * the other designs' frames are left alone.
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
          designId: designId ?? undefined,
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
    [mockup, areaScope, designId],
  );

  // Auto-save the draft. It is debounced (a drag writes once) and uses the
  // chosen scope: every mockup of this type by default, so one save per
  // design is enough before moving to the next tab. The save is also held
  // while the user is gesturing on the canvas - a mid-drag write would land
  // on every same-type mockup at a frame the pointer is still moving, and
  // its render pass would re-render the stage under the pointer. When the
  // pointer comes up, `interactTick` re-arms this effect.
  React.useEffect(() => {
    if (!dirty || !mockup || !area) return;
    if (interactingRef.current) return;
    // Only a draft the user actually made on THIS tab may be saved. On the
    // commit where the tab changed, `area` is still the previous tab's draft,
    // so arming a timeout here would write it to the wrong design.
    if (draftOwner.current !== `${mockup.id}:${designId ?? ""}`) return;
    pendingDraft.current = {
      mockupId: mockup.id,
      designId,
      area,
      scope: areaScope,
    };
    const handle = setTimeout(() => {
      pendingDraft.current = null;
      autoSaveTimer.current = null;
      // The save renders on its own now: once the frame is stored, the
      // active design's render pass runs in the background, from the SAVED
      // areas, exactly as the old buttons would have.
      void persistArea(area).then((result) => {
        if (result.updated > 0) void autoRenderAllRef.current(designId);
      });
    }, 700);
    autoSaveTimer.current = handle;
    return () => {
      clearTimeout(handle);
      if (autoSaveTimer.current === handle) autoSaveTimer.current = null;
    };
  }, [dirty, area, mockup, areaScope, persistArea, designId, interactTick]);

  // A full navigation can unmount the panel before the debounce fires. Kick
  // the pending write so leaving the page does not discard the last drag.
  React.useEffect(
    () => () => {
      const pending = pendingDraft.current;
      if (!pending) return;
      pendingDraft.current = null;
      void applyPrintAreaToMockups({
        sourceMockupId: pending.mockupId,
        designId: pending.designId ?? undefined,
        area: pending.area,
        scope: pending.scope,
      });
    },
    [],
  );

  /** The exact print area of the product selected in the Printify Studio. */
  const _useStudioArea = () => {
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

  const _applyPreset = (presetId: string) => {
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

  const _useManualSize = () => {
    const w = Number(_customWidth);
    const h = Number(_customHeight);
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

  const _saveArea = async () => {
    if (!mockup || !area) return;
    await persistArea(area, { notify: true });
  };

  // --- the Studio's placement ------------------------------------------------
  // Placement is edited in the Printify Studio (the Design panel). This is
  // the only writer of placements. The auto-fit action was removed on
  // purpose and must never come back.

  /**
   * Makes this the mockup's placeholder for EVERY design.
   *
   * The per-design overrides in the Studio session are dropped, so every
   * design lands in the same spot inside this area.
   */
  const _setAsPlaceholder = async () => {
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
  const _saveReference = () => {
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

  const _clearReference = () => {
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
      // The template becomes THIS design's area, never the shared default.
      await savePrintArea(id, printAreaFromTemplate(tpl.payload), designId ?? undefined);
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

  // --- the background render pass -------------------------------------------
  /** Live design list and catalogue for the pass, read through refs so the
      timer-triggered calls never see a stale snapshot. */
  const designsRef = React.useRef<Design[]>([]);
  designsRef.current = (designs ?? []) as Design[];
  const catalogRef = React.useRef(catalog);
  catalogRef.current = catalog;
  /**
   * Renders the given design onto every mockup that has a print area for it,
   * IN THE BACKGROUND — no button anywhere.
   *
   * Three events invite this pass: the debounced area save landing, a design
   * tab switching (the flush is also a save, so the design that leaves the
   * screen still gets its pixels), and the tab loading or its placement
   * moving, which only BACKFILLS designs with no render at the current
   * fingerprint. That fingerprint check is what keeps a repeat invite cheap:
   * the pass re-reads the stored areas, resolves each target through the SAME
   * `renderComposition` plan the preview uses (so the pixels stay identical
   * to what Listing images adopts), and skips every target whose recorded
   * fingerprint already matches.
   *
   * Success is silent — the busy chip in the header is the only surface. Only
   * real failures reach a toast. A pair's white-ink half is a silent skip:
   * the pair belongs to its black half, and saving there renders it.
   */
  const autoRenderAll = async (requestedDesignId: string | null): Promise<void> => {
    if (!requestedDesignId) return;
    if (autoRenderBusy.current) {
      autoRenderRerun.current = requestedDesignId;
      return;
    }
    const design = designsRef.current.find((d) => d.id === requestedDesignId);
    if (!design) return;
    autoRenderBusy.current = true;
    setBulkRendering(true);
    let done = 0;
    let failed = 0;
    try {
      // Both halves of a pair render now: the strip covers every member's
      // artwork, and linkSavedRender files each render under its own design.
      const freshMockups = await db.mockups.toArray();
      const targets = freshMockups.filter((m) => isProductMockup(m) && printAreaOf(m, design.id));
      if (targets.length === 0) return;
      const latest = await loadSession();
      const artworkAssetId = designMainAssetId(design);
      const renderedTargets: Array<{
        mockupId: string;
        assetId: string;
        fingerprint: string;
      }> = [];
      for (const target of targets) {
        try {
          const { plan, fp } = await resolveRenderPlanWithFingerprint({
            designId: design.id,
            designAssetId: artworkAssetId,
            mockup: target,
            session: latest,
          });
          const existing = await findAdoptableRender({
            artworkAssetId,
            mockupId: target.id,
            fingerprint: fp,
          });
          if (existing) continue;
          const assetId = await renderComposition({
            designId: design.id,
            mockupId: target.id,
            designAssetId: artworkAssetId,
            transform: plan.transform,
            clip: plan.clip ?? null,
            behindMockup: plan.behindMockup,
            renderFp: fp,
          });
          renderedTargets.push({ mockupId: target.id, assetId, fingerprint: fp });
          done += 1;
        } catch {
          failed += 1;
        }
      }

      // Save AND use whatever the pass produced, exactly as the render
      // buttons did: the session entries are what Listing images, preview,
      // Send and the drafts read.
      if (renderedTargets.length > 0) {
        let next = await loadSession();
        let linkedName: string | null = null;
        for (const target of renderedTargets) {
          const link = linkSavedRender({
            designId: design.id,
            mockupId: target.mockupId,
            assetId: target.assetId,
            fingerprint: target.fingerprint,
            session: next,
            designs: designsRef.current,
          });
          if (link.status !== "linked") continue;
          next = { ...next, ...link.patch, updatedAt: Date.now() };
          linkedName = link.listing.designName;
        }
        if (linkedName) {
          await saveSession(next);
          setSession(next);
          try {
            await saveStudioListingDrafts({
              session: next,
              listings: buildStudioListings(designsRef.current, next),
              productName: catalogProductName(catalogRef.current.blueprints, next.blueprintId),
              copyMode: "preserve",
              lockSelection: true,
            });
          } catch {
            // The session entries are safe; drafts can catch up later.
          }
        }
      }

      if (done > 0) {
        await logActivity(
          "batch.item",
          `Rendered "${design.name}" on ${done} mockup${done === 1 ? "" : "s"}`,
        );
      }
      // A failure is never silent, even when the successes are.
      if (failed > 0) {
        toast.error(`${failed} render${failed === 1 ? "" : "s"} failed`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The mockups could not be rendered");
    } finally {
      autoRenderBusy.current = false;
      setBulkRendering(false);
      // A trigger that arrived mid-pass is honoured once, not dropped.
      const rerun = autoRenderRerun.current;
      autoRenderRerun.current = null;
      if (rerun && rerun !== requestedDesignId) void autoRenderAll(rerun);
    }
  };
  // The ref points at the pass only once it exists — the effects and timers
  // above call through the ref, always reaching the newest closure.
  autoRenderAllRef.current = autoRenderAll;

  // --- readouts --------------------------------------------------------------
  const _physical = area ? areaInches(area, mockupW, mockupH) : null;
  const _scopeCount =
    mockup && mockups ? printAreaScopeTargets(mockups, mockup, areaScope).length : 0;
  const _designSize =
    area && placement && designMeta.w > 0
      ? designInches(placement.scale, designMeta.h / designMeta.w, area, mockupW, mockupH)
      : null;

  const _sourceLabel = (() => {
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
          <span className="text-sm font-semibold">Mockups</span>
          <span className="text-xs text-ink-muted">{mockups?.length ?? 0}</span>
        </div>
        <div className="max-h-[640px] overflow-auto p-2">
          {(mockups ?? []).map((m) => {
            const selected = m.id === selectedId;
            // The rail shows the ACTIVE design's area, because that is what
            // the tab edits. Another design's frame on the same photo does not
            // make this design's tab non-empty.
            const mArea = printAreaOf(m, designId);
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
                  <div className="truncate text-sm font-medium">{m.name}</div>
                  <div className="text-xs text-ink-muted">
                    {m.width}×{m.height} · {CATEGORY_SINGULAR[m.category]}
                  </div>
                  {mArea ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-xs">
                        {mArea.areaWidth}×{mArea.areaHeight}
                      </Badge>
                      {mArea.reference ? (
                        <Badge variant="muted" className="text-xs">
                          ref {mArea.reference.inches} in
                        </Badge>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-1 text-[10.5px] text-ink-muted">no area yet</div>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </Card>

      {/* --- the workspace --- */}
      <div className="min-w-0">
        {/* The per-design tabs: one small numbered tab per design, oldest
            first - tab 1 is the first uploaded design, matching the Studio's
            design order and the product-creation loop. The tab shows only its
            number; the design's name lives in the title and the aria-label,
            which is what screen readers and tests address. Everything below -
            the canvas, the frame, the renders - is THAT design only, and it
            shows the placement the Printify Studio uses for it. Save on one
            mockup, move to the next tab. */}
        {tabDesigns.length === 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-muted">
              Upload a design in the Printify Studio to place it on a mockup.
            </span>
          </div>
        ) : (
          <div className="mb-3 flex items-end gap-2 border-b border-border-subtle">
            <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" id="design-tabs">
              {tabDesigns.map((d, i) => {
                const active = d.id === designId;
                // The number is all that is visible; the name stays the
                // accessible name, so screen readers and tests still address
                // the tab by it.
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDesignId(d.id)}
                    title={d.name}
                    aria-label={d.name}
                    className={`border-b-2 px-2.5 py-1 text-xs font-semibold transition-colors ${
                      active
                        ? "border-forest text-forest"
                        : "border-transparent text-ink-muted hover:text-ink"
                    }`}
                  >
                    {i + 1}
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
          {/* The tabs show numbers, so this line is the only place the active
              design's name is on screen - it names what the canvas below is
              editing. */}
          {design ? (
            <span className="text-xs text-ink-muted">{design.name}</span>
          ) : null}
          {/* The renders happen in the background now: the pass that saves and
              renders runs on its own, so the only surface it has is this
              quiet busy chip. */}
          {bulkRendering ? (
            <div className="ml-auto flex items-center gap-1.5 text-xs text-ink-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering…
            </div>
          ) : null}
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
                  _setReferenceOpen(true);
                }}
                onInteractStart={onInteractStart}
                onInteractEnd={onInteractEnd}
              />
            ) : (
              <Card className="p-8 text-center text-sm text-ink-muted">
                Upload a mockup to set a print area on it.
              </Card>
            )}
          </div>

          {/* --- the controls --- */}
          <div className="flex flex-col gap-3">
            <Card className="p-3">
              {/* The visible window: a folded shirt shows only part of the
                  area, so the design is cut at the fold. */}
              {area ? (
                <div className="mb-3 rounded-md border border-border-subtle p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[11.5px] font-medium">
                      <Crop className="h-3 w-3" /> Visible window
                    </span>
                    <span className="text-xs text-ink-muted">{describeCrop(crop)}</span>
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
                </div>
              ) : null}
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
              </div>
            </Card>
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
  onInteractStart,
  onInteractEnd,
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
  onInteractStart: () => void;
  onInteractEnd: () => void;
}) {
  const [mockupUrl, setMockupUrl] = React.useState<string | null>(null);
  const [designUrl, setDesignUrl] = React.useState<string | null>(null);
  const [missingMockupBlob, setMissingMockupBlob] = React.useState(false);

  React.useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setMissingMockupBlob(false);
    void getAssetBlob(mockup.assetId).then((blob) => {
      if (cancelled) return;
      if (!blob) {
        setMissingMockupBlob(true);
        return;
      }
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

  if (missingMockupBlob) {
    return (
      <Card className="grid min-h-[420px] place-items-center p-6 text-center">
        <div>
          <p className="text-[15px] font-bold text-ink">This mockup image is missing.</p>
          <p className="mt-1 text-sm text-ink-muted">
            Re-upload it on the Mockups tab; the print area opens after the image is back.
          </p>
        </div>
      </Card>
    );
  }

  if (!mockupUrl) {
    return (
      <Card className="grid min-h-[420px] place-items-center text-sm text-ink-muted">
        Loading the mockup…
      </Card>
    );
  }

  return (
    <PrintAreaCanvasBoundary>
      <React.Suspense
        fallback={
          <Card className="grid min-h-[420px] place-items-center text-sm text-ink-muted">
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
          onInteractStart={onInteractStart}
          onInteractEnd={onInteractEnd}
        />
      </React.Suspense>
    </PrintAreaCanvasBoundary>
  );
}
