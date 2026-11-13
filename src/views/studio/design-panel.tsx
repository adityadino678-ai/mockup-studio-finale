"use client";

// ---------------------------------------------------------------------------
// The Design panel's two pieces: the gallery of designs and the panel that
// adjusts ONE design's placement.
//
// The gallery is shared with the Designs tab, so the two can never drift
// apart - the user asked for the panel to look like the Designs page, and
// the only reliable way to get that is to render the same card twice.
//
// The adjustment panel holds NOTHING but the placement: no title, no price,
// no colour list, no results. Those belong to the listing, and a panel that
// mixes the two is how a user ends up editing the wrong thing.
// ---------------------------------------------------------------------------

import * as React from "react";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { DesignCard, type DesignCardData } from "@/components/studio/design-card";
import { PrintAreaPreview } from "@/components/studio/print-area-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel, Input } from "@/components/ui/input";
import { designMainAssetId, getAssetBlob } from "@/lib/db/repo";
import { decodeImage } from "@/lib/image/image";
import {
  type DesignColourPlan,
} from "@/lib/printify/design-colours";
import { ROW_HINTS, ROW_LABELS } from "@/lib/printify/studio-session";
import { splitDesignsByInkPair, type SeparableDesign } from "@/lib/printify/design-colours";
import type { Design, StudioPlacement, StudioRowId, StudioSession } from "@/types/domain";
import { Crosshair } from "lucide-react";

/** A swatch, as the cards draw them. */
export type DesignSwatch = { name: string; hex: string; ink?: "black" | "white" | "ambiguous" };

/**
 * What ONE design prints on, for its card.
 *
 * The rows are split by the product, so a card can no longer show its row's
 * colours: a design without ink artwork prints on the plain AND the ink
 * colours with its main artwork, and a design with ink artwork prints on
 * the plain ones with its main artwork and on the ink ones with its ink
 * artwork. The caller knows the product, so the caller says what each card
 * shows.
 */
export interface DesignColours {
  /** The colour names this design will be printed on. */
  colors: string[];
  /** The swatch data for those colours. */
  swatches: DesignSwatch[];
}

/**
 * The colour groups of the ONE product in the session.
 *
 * Re-exported from the pure colour module: the Studio, the listing views and
 * the autopilot all read the same split.
 */
export { productColourGroups } from "@/lib/printify/design-colours";

/**
 * The split to show, for the session.
 *
 * The split is exactly what the user ticked in the Designs tab: the ids in
 * `session.inkPairIds` are the "Has ink variants" row and every other design
 * is "No ink variants". Nothing about the product, and nothing about the ink
 * artwork on file, changes that - the user decides, the app obeys.
 */
export function splitDesignsForSession<T extends SeparableDesign>(
  designs: T[],
  session: StudioSession,
): { plain: T[]; ink: T[] } {
  return splitDesignsByInkPair(designs, session.inkPairIds ?? []);
}

/**
 * The swatches a design's plan prints on.
 *
 * A colour printed with the MAIN artwork carries no ink badge - the artwork
 * is the design itself. A colour printed with an ink artwork carries the
 * badge of that ink, so the card says what will actually be printed.
 */
export function swatchesForPlan(
  plan: DesignColourPlan,
  hexFor: (name: string) => string,
): DesignSwatch[] {
  const out: DesignSwatch[] = [];
  for (const group of plan.groups) {
    const ink =
      group.ink === "black" ? ("black" as const) : group.ink === "white" ? ("white" as const) : undefined;
    for (const name of group.colors) {
      out.push({ name, hex: hexFor(name), ink });
    }
  }
  return out;
}

/**
 * What an empty row says.
 *
 * Both rows are ALWAYS rendered: a row that is hidden when it is empty is a
 * row the user cannot see the meaning of, and the split between "no ink
 * variants" and "has ink variants" is the whole point of the page.
 */
export const DESIGN_ROW_EMPTY: Record<StudioRowId, { title: string; hint: string }> = {
  plain: {
    title: "No designs without ink variants yet",
    hint: "Upload a design above and it will appear here.",
  },
  ink: {
    title: "No designs with ink variants yet",
    hint: 'Tick "Ink variants" on a design card and it will appear here.',
  },
};

export interface DesignGalleryProps {
  /** Which row this gallery is. */
  row: StudioRowId;
  /** The designs in the row, already split by the caller. */
  designs: DesignCardData[];
  /** The colour swatches the row's colours resolve to. */
  swatches?: DesignSwatch[];
  /**
   * What each design prints on.
   *
   * When this is given it wins over the row's swatches: the rows are split
   * by the product, so a design's colours are not the row's colours any
   * more.
   */
  designColours?: (design: DesignCardData) => DesignColours | undefined;
  /** The ids ticked for the batch scope. */
  selectedIds?: string[];
  /** Show the batch-scope checkbox. */
  showCheckbox?: boolean;
  onToggle?: (id: string) => void;
  /** The designs the user marked as "has ink variants". */
  inkPairIds?: readonly string[];
  /** Ticks / unticks a design as "has ink variants". Omit to hide the box. */
  onToggleInkPair?: (id: string) => void;
  /** The pair a design belongs to: the partner's name and the design's role. */
  pairInfo?: (id: string) => { partnerName: string; role: "black" | "white" } | undefined;
  /** Moves a paired design to the other half of its pair. */
  onSetInkRole?: (id: string, role: "black" | "white") => void;
  /** Breaks a design's pair. */
  onUnpair?: (id: string) => void;
  /**
   * Pairs the two UNPAIRED designs in this row as one listing.
   *
   * Only offered when the row holds exactly two of them: that is the moment
   * the user's intent is unambiguous ("these two, one listing"), and it saves
   * them from finding the batch checkboxes first. The first card is the
   * black-ink half; the cards let them swap the roles afterwards.
   */
  onPairInk?: (blackInkDesignId: string, whiteInkDesignId: string) => void;
  /** The designs the user ticked for a "Design pair" (front + back). */
  designPairIds?: readonly string[];
  /** Ticks / unticks "Design pair". Omit to hide the box. */
  onToggleDesignPair?: (id: string) => void;
  /** The DESIGN pair a design belongs to: partner name and its side. */
  designPairInfo?: (id: string) => { partnerName: string; role: "front" | "back" } | undefined;
  /** Moves a design-paired design to the other side of its pair. */
  onSetDesignPairRole?: (id: string, role: "front" | "back") => void;
  /** Breaks a design's DESIGN pair. */
  onUnpairDesignPair?: (id: string) => void;
  /** Called when a card's body is clicked. */
  onOpen?: (id: string) => void;
  /** The per-design actions in the card's "…" menu. */
  onEditDesign?: (id: string) => void;
  onInkVariants?: (id: string) => void;
  onRemoveBackground?: (id: string) => void;
  onDownload?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
}

/**
 * One row of the designs gallery: the heading, the count and the cards.
 *
 * The heading carries the count in brackets ("No ink variants (2)"), which is
 * the wording the acceptance tests already look for.
 */
export function DesignGallery({
  row,
  designs,
  swatches,
  designColours,
  selectedIds,
  showCheckbox = false,
  onToggle,
  inkPairIds,
  onToggleInkPair,
  pairInfo,
  onSetInkRole,
  onUnpair,
  onPairInk,
  designPairIds,
  onToggleDesignPair,
  designPairInfo,
  onSetDesignPairRole,
  onUnpairDesignPair,
  onOpen,
  onEditDesign,
  onInkVariants,
  onRemoveBackground,
  onDownload,
  onDuplicate,
  onDelete,
}: DesignGalleryProps) {
  // The designs the user could pair RIGHT NOW: ink-ticked and not already in
  // a pair. Two of them is the whole gesture - no batch selection needed.
  const pairable = onPairInk
    ? designs.filter((d) => (inkPairIds?.includes(d.id) ?? false) && !pairInfo?.(d.id))
    : [];

  return (
    <section data-design-row={row}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">
          {ROW_LABELS[row]}{" "}
          <span className="font-normal text-ink-muted">({designs.length})</span>
        </h2>
        <p className="text-xs text-ink-muted">{ROW_HINTS[row]}</p>
      </div>

      {onPairInk && row === "ink" && designs.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2" data-pair-action="">
          {pairable.length === 2 ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPairInk(pairable[0].id, pairable[1].id)}
                title="One product: the two designs print on the same placeholder, split by ink colour. The first card is the black-ink half."
              >
                <Link2 className="h-3.5 w-3.5" /> Pair these two as one listing
              </Button>
              <span className="text-xs text-ink-muted">
                Same placeholder, one for black ink and one for white ink.
              </span>
            </>
          ) : pairable.length === 1 ? (
            <span className="text-xs text-ink-muted">
              Tick another design&apos;s &ldquo;Ink variants&rdquo; box to pair the two as one
              listing.
            </span>
          ) : pairable.length === 0 ? (
            <span className="text-xs text-ink-muted">
              Every design in this row is already paired.
            </span>
          ) : (
            <span className="text-xs text-ink-muted">
              Tick exactly two designs&apos; &ldquo;Ink variants&rdquo; boxes to pair them.
            </span>
          )}
        </div>
      )}

      {designs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle bg-surface-muted/40 px-4 py-3">
          <p className="text-xs font-medium text-ink">{DESIGN_ROW_EMPTY[row].title}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{DESIGN_ROW_EMPTY[row].hint}</p>
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {designs.map((d) => {
            const own = designColours?.(d);
            return (
              <DesignCard
                key={d.id}
                design={d}
                selected={selectedIds?.includes(d.id) ?? false}
                showCheckbox={showCheckbox}
                onToggle={onToggle ? () => onToggle(d.id) : undefined}
                swatches={own?.swatches ?? swatches}
                colors={own?.colors}
                inkPair={inkPairIds?.includes(d.id) ?? false}
                onToggleInkPair={onToggleInkPair ? () => onToggleInkPair(d.id) : undefined}
                pairInfo={pairInfo?.(d.id)}
                onSetInkRole={onSetInkRole ? (role) => onSetInkRole(d.id, role) : undefined}
                onUnpair={onUnpair ? () => onUnpair(d.id) : undefined}
                designPair={designPairIds?.includes(d.id) ?? false}
                onToggleDesignPair={
                  onToggleDesignPair ? () => onToggleDesignPair(d.id) : undefined
                }
                designPairInfo={designPairInfo?.(d.id)}
                onSetDesignPairRole={
                  onSetDesignPairRole ? (role) => onSetDesignPairRole(d.id, role) : undefined
                }
                onUnpairDesignPair={
                  onUnpairDesignPair ? () => onUnpairDesignPair(d.id) : undefined
                }
                onOpen={onOpen ? () => onOpen(d.id) : undefined}
                onEdit={onEditDesign ? () => onEditDesign(d.id) : undefined}
                onInkVariants={onInkVariants ? () => onInkVariants(d.id) : undefined}
                onRemoveBackground={
                  onRemoveBackground ? () => onRemoveBackground(d.id) : undefined
                }
                onDownload={onDownload ? () => onDownload(d.id) : undefined}
                onDuplicate={onDuplicate ? () => onDuplicate(d.id) : undefined}
                onDelete={onDelete ? () => onDelete(d.id) : undefined}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

/** A print area of the product. */
export interface PrintAreaOption {
  position: string;
  width: number;
  height: number;
}

export interface DesignAdjustmentPanelProps {
  /** The design being adjusted. */
  design: Design;
  session: StudioSession;
  update: (patch: Partial<StudioSession>) => void;
  /** The print area the design's placement currently points at. */
  area: PrintAreaOption | undefined;
  onClose: () => void;
  /** Every print area the product offers. */
  printAreas?: ReadonlyArray<PrintAreaOption>;
  /**
   * The position this dialog opens on, when the design's side is FIXED by a
   * pair: a design pair's front half opens on "front", its back half on
   * "back". Absent, the dialog opens on the design's own placement position.
   */
  defaultPosition?: string;
}

/**
 * The adjustment panel: where ONE design's artwork sits in the print area.
 *
 * Each design owns its placement. Every mockup with a print area uses that
 * same placement, mapped through the mockup's own frame. Editing this design
 * never moves another design.
 */
export function DesignAdjustmentPanel({
  design,
  session,
  update,
  area,
  onClose,
  printAreas,
  defaultPosition,
}: DesignAdjustmentPanelProps) {
  const [artwork, setArtwork] = React.useState<{ url: string; width: number; height: number } | null>(
    null,
  );

  const assetId = designMainAssetId(design);

  /**
   * The artwork of THIS design, with its real pixel size: the preview needs
   * the natural size to keep the artwork's aspect ratio.
   */
  React.useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      const blob = await getAssetBlob(assetId);
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      let width = 0;
      let height = 0;
      try {
        const bmp = await decodeImage(blob);
        width = bmp.width;
        height = bmp.height;
        bmp.close();
      } catch {
        // The preview falls back to a square when the size is unknown.
      }
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      setArtwork({ url, width, height });
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [assetId]);

  /** The placement of THIS design, for the position being edited. */
  const [position, setPosition] = React.useState<string>(
    () =>
      defaultPosition ??
      (session.placements[design.id] ?? session.universalPlacement).position,
  );
  const editing: StudioPlacement = React.useMemo(() => {
    // This position's own values when the user tuned them before; otherwise
    // the design's shared values under this position's name, so switching
    // FRONT/BACK starts from what is on screen rather than from nothing.
    const perPosition = session.placementsByPosition?.[design.id]?.[position];
    if (perPosition) return perPosition;
    const shared = session.placements[design.id] ?? session.universalPlacement;
    return { ...shared, position };
  }, [
    session.placementsByPosition,
    session.placements,
    session.universalPlacement,
    design.id,
    position,
  ]);

  /**
   * Writes THIS design's placement for the position being edited.
   *
   * The values are rounded on write: a drag produces raw floats like
   * 0.5045991124897677, which is not a value the number inputs can show.
   * They are stored under THIS position AND mirrored into the design's
   * shared placement, so every existing reader (the Mockups tab renders,
   * the listing fingerprints, product creation) sees the edit without
   * knowing about per-position storage.
   */
  const setPlacement = (patch: Partial<StudioPlacement>) => {
    const merged = { ...editing, ...patch };
    const next: StudioPlacement = {
      position,
      x: Math.round(merged.x * 1000) / 1000,
      y: Math.round(merged.y * 1000) / 1000,
      scale: Math.round(merged.scale * 1000) / 1000,
      angle: Math.round(merged.angle * 10) / 10,
    };
    update({
      placementsByPosition: {
        ...(session.placementsByPosition ?? {}),
        [design.id]: {
          ...(session.placementsByPosition?.[design.id] ?? {}),
          [position]: next,
        },
      },
      placements: { ...session.placements, [design.id]: next },
    });
  };

  /**
   * Copies this placement onto every design.
   *
   * Clearing `placements` is deliberate: it makes the copy the default for
   * every design, so an old override cannot resurface on a design the user
   * has not touched.
   */
  const applyToEveryDesign = () => {
    update({
      universalPlacement: editing,
      placements: {},
      placementsByPosition: {},
    });
    toast.success("Placement used for every design");
  };

  const areas: PrintAreaOption[] =
    printAreas && printAreas.length > 0 ? [...printAreas] : area ? [area] : [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-x-hidden overflow-y-auto"
        data-design-panel={design.id}
      >
        <DialogHeader>
          <DialogTitle>
            <Crosshair className="h-4 w-4" /> Adjust "{design.name}"
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[260px_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="studio-print-area">Print area</FieldLabel>
              <div id="studio-print-area" className="flex flex-wrap gap-1.5">
                {areas.map((a) => (
                  <Button
                    key={a.position}
                    size="sm"
                    variant={position === a.position ? "default" : "outline"}
                    onClick={() => setPosition(a.position)}
                    className="h-7 text-xs"
                  >
                    {a.position}
                  </Button>
                ))}
              </div>
              {area && (
                <p className="text-xs text-ink-muted">
                  {area.width} × {area.height} px
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <FieldLabel htmlFor="studio-scale">
                Width ({Math.round(editing.scale * 100)}% of the area)
              </FieldLabel>
              <input
                id="studio-scale"
                type="range"
                min={5}
                // A design can be WIDER than the print area: the part that
                // falls outside is cropped off, exactly as Printify crops it.
                // The mockups tab can set that, so the slider has to show it.
                max={200}
                value={Math.round(editing.scale * 100)}
                onChange={(e) => setPlacement({ scale: Number(e.target.value) / 100 })}
                className="h-8 w-full accent-[#314d3d]"
              />
            </div>

            <div className="space-y-1.5">
              <FieldLabel htmlFor="studio-angle">Rotation ({Math.round(editing.angle)}°)</FieldLabel>
              <input
                id="studio-angle"
                type="range"
                min={-180}
                max={180}
                value={editing.angle}
                onChange={(e) => setPlacement({ angle: Number(e.target.value) })}
                className="h-8 w-full accent-[#314d3d]"
              />
            </div>

            <div className="flex gap-2">
              <div className="w-1/2 space-y-1.5">
                <FieldLabel htmlFor="studio-x">Centre X</FieldLabel>
                <Input
                  id="studio-x"
                  type="number"
                  step={0.01}
                  min={0}
                  max={1}
                  value={editing.x}
                  onChange={(e) => setPlacement({ x: Number(e.target.value) })}
                  className="h-8 text-xs"
                />
              </div>
              <div className="w-1/2 space-y-1.5">
                <FieldLabel htmlFor="studio-y">Centre Y</FieldLabel>
                <Input
                  id="studio-y"
                  type="number"
                  step={0.01}
                  min={0}
                  max={1}
                  value={editing.y}
                  onChange={(e) => setPlacement({ y: Number(e.target.value) })}
                  className="h-8 text-xs"
                />
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-2">
            <PrintAreaPreview
              artworkUrl={artwork?.url ?? null}
              artworkWidth={artwork?.width ?? 0}
              artworkHeight={artwork?.height ?? 0}
              areaWidth={area?.width ?? 3000}
              areaHeight={area?.height ?? 3000}
              placement={editing}
              onChange={setPlacement}
              className="mx-auto max-w-[320px]"
            />
          </div>
        </div>

        <DialogFooter className="flex-wrap justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={applyToEveryDesign}>
              Use for every design
            </Button>
          </div>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
