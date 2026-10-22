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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/primitives";
import { designMainAssetId, getAssetBlob } from "@/lib/db/repo";
import { decodeImage } from "@/lib/image/image";
import {
  type DesignColourPlan,
} from "@/lib/printify/design-colours";
import { ROW_HINTS, ROW_LABELS } from "@/lib/printify/studio-session";
import {
  splitDesignsByInkPair,
  type ProductColourGroups,
  type SeparableDesign,
} from "@/lib/printify/design-colours";
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
 * The colours are split into two groups ONCE, in the Colors tab, and every
 * other view reads them from here. That is what keeps the Designs tab and
 * the Design panel from disagreeing about which colours print with the ink
 * artwork - the disagreement that used to leave a design printing on
 * nothing.
 */
export function productColourGroups(session: StudioSession): ProductColourGroups {
  return {
    plain: session.rows.plain?.colors ?? [],
    ink: session.rows.ink?.colors ?? [],
    blackInk: session.rows.ink?.blackInkColors ?? [],
  };
}

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
    hint: "Upload a design on the Designs page and it will appear here.",
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
  /** Called when a card's body is clicked. */
  onOpen?: (id: string) => void;
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
  onOpen,
}: DesignGalleryProps) {
  // The designs the user could pair RIGHT NOW: ink-ticked and not already in
  // a pair. Two of them is the whole gesture - no batch selection needed.
  const pairable = onPairInk
    ? designs.filter((d) => (inkPairIds?.includes(d.id) ?? false) && !pairInfo?.(d.id))
    : [];

  return (
    <section data-design-row={row}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-ink">
          {ROW_LABELS[row]}{" "}
          <span className="font-normal text-ink-subtle">({designs.length})</span>
        </h2>
        <p className="text-[11px] text-ink-muted">{ROW_HINTS[row]}</p>
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
              <span className="text-[11px] text-ink-subtle">
                Same placeholder, one for black ink and one for white ink.
              </span>
            </>
          ) : pairable.length === 1 ? (
            <span className="text-[11px] text-ink-subtle">
              Tick another design&apos;s &ldquo;Ink variants&rdquo; box to pair the two as one
              listing.
            </span>
          ) : pairable.length === 0 ? (
            <span className="text-[11px] text-ink-subtle">
              Every design in this row is already paired.
            </span>
          ) : (
            <span className="text-[11px] text-ink-subtle">
              Pick two with the card checkboxes, then press &ldquo;Pair for one listing&rdquo;.
            </span>
          )}
        </div>
      )}

      {designs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle bg-surface-muted/40 px-4 py-3">
          <p className="text-[12px] font-medium text-ink">{DESIGN_ROW_EMPTY[row].title}</p>
          <p className="mt-0.5 text-[11px] text-ink-muted">{DESIGN_ROW_EMPTY[row].hint}</p>
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
                onOpen={onOpen ? () => onOpen(d.id) : undefined}
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
}

/**
 * The adjustment panel: where ONE design's artwork sits in the print area.
 *
 * It edits the same placement the listing uses - `universalPlacement` when
 * "one placement for every design" is on, this design's own entry otherwise
 * - so what the user arranges here is what gets created.
 */
export function DesignAdjustmentPanel({
  design,
  session,
  update,
  area,
  onClose,
  printAreas,
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

  /** The placement being edited, honouring the universal toggle. */
  const editing: StudioPlacement = React.useMemo(() => {
    if (session.universal) return session.universalPlacement;
    return session.placements[design.id] ?? session.universalPlacement;
  }, [session.universal, session.universalPlacement, session.placements, design.id]);

  /**
   * Writes the placement.
   *
   * The values are rounded on write: a drag produces raw floats like
   * 0.5045991124897677, which is not a value the number inputs can show.
   */
  const setPlacement = (patch: Partial<StudioPlacement>) => {
    const merged = { ...editing, ...patch };
    const next: StudioPlacement = {
      position: merged.position,
      x: Math.round(merged.x * 1000) / 1000,
      y: Math.round(merged.y * 1000) / 1000,
      scale: Math.round(merged.scale * 1000) / 1000,
      angle: Math.round(merged.angle * 10) / 10,
    };
    if (session.universal) {
      update({ universalPlacement: next });
      return;
    }
    update({ placements: { ...session.placements, [design.id]: next } });
  };

  /** Copies the placement onto this design only. */
  const applyToThisDesign = () => {
    update({
      universal: false,
      placements: { ...session.placements, [design.id]: editing },
    });
    toast.success(`Placement applied to "${design.name}"`);
  };

  /** Copies the placement onto every design in the batch. */
  const applyToEveryDesign = () => {
    update({ universal: true, universalPlacement: editing });
    toast.success("Placement applied to every design");
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
          <DialogDescription>
            Where the artwork sits in the print area. Drag it to move it, use the round handle to
            rotate it, and it snaps to the centre and the edges.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface-muted/60 px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2">
            <Switch
              checked={session.universal}
              onCheckedChange={(v) => update({ universal: v })}
              aria-label="Use one placement for every design"
              id="studio-universal"
            />
            <span className="text-[12px] text-ink">One placement for every design</span>
          </label>
          <span className="text-[11px] text-ink-subtle">
            {session.universal
              ? "Every design in the batch uses this placement."
              : `Only "${design.name}" uses its own placement.`}
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-[260px_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="studio-print-area">Print area</FieldLabel>
              <div id="studio-print-area" className="flex flex-wrap gap-1.5">
                {areas.map((a) => (
                  <Button
                    key={a.position}
                    size="sm"
                    variant={editing.position === a.position ? "default" : "outline"}
                    onClick={() => setPlacement({ position: a.position })}
                    className="h-7 text-[12px]"
                  >
                    {a.position}
                  </Button>
                ))}
              </div>
              {area && (
                <p className="text-[11px] text-ink-subtle">
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
                  className="h-8 text-[12px]"
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
                  className="h-8 text-[12px]"
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
            <p className="text-[11px] leading-relaxed text-ink-subtle">
              The dashed frame is the print area; Printify does not publish where that frame sits on
              the garment, so the position on the shirt itself is an approximation. Anything outside
              the frame is cropped, exactly as Printify crops it.
            </p>
          </div>
        </div>

        <DialogFooter className="flex-wrap justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={applyToThisDesign}>
              Apply to this design
            </Button>
            <Button size="sm" variant="outline" onClick={applyToEveryDesign}>
              Apply to every design
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
