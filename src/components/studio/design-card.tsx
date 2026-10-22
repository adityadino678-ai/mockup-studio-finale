"use client";

import * as React from "react";
import { AssetThumb } from "@/components/asset-thumb";
import { ColorSwatchRow } from "@/components/studio/color-swatch";
import { Badge, Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/**
 * Everything a card needs to draw one design.
 *
 * The caller formats the dimensions (`"3232 × 4024 px"`) because only the
 * caller knows the wording the rest of the studio uses.
 */
export interface DesignCardData {
  id: string;
  name: string;
  originalAssetId: string;
  processedAssetId?: string;
  whiteInkAssetId?: string;
  blackInkAssetId?: string;
  /** e.g. "3232 × 4024 px" - already formatted by the caller. */
  dimensions: string;
}

export interface DesignCardProps {
  design: DesignCardData;
  selected?: boolean;
  /** Show the batch-selection checkbox (the bulk actions' scope). */
  showCheckbox?: boolean;
  onToggle?: () => void;
  /** The colour swatches this design's colours resolve to. */
  swatches?: Array<{ name: string; hex: string; ink?: "black" | "white" | "ambiguous" }>;
  /**
   * The colour names THIS design will be printed on.
   *
   * Optional, and only a filter: when it is given, only the swatches of
   * those colours are drawn. A design the user paired prints its ink artwork
   * on the ink colours, so the card can no longer assume its row's colours.
   */
  colors?: string[];
  /**
   * True when the user ticked this design as "has ink variants".
   *
   * This is the separation itself: the checkbox below is the ONLY thing that
   * decides whether the design is printed with ink artwork, so the app never
   * guesses a pairing on the user's behalf.
   */
  inkPair?: boolean;
  /** Ticks / unticks "has ink variants". Omit to hide the checkbox. */
  onToggleInkPair?: () => void;
  /**
   * The pair this design belongs to, when the user paired two designs.
   *
   * A paired design prints half of one product: the black-ink design on the
   * plain and black-ink colours, the white-ink one on the remaining ink
   * colours. The partner name is shown so the two cards describe the same
   * listing.
   */
  pairInfo?: { partnerName: string; role: "black" | "white" };
  /** Moves this design to the other half of its pair. */
  onSetInkRole?: (role: "black" | "white") => void;
  /** Breaks the pair. */
  onUnpair?: () => void;
  /** Called when the card BODY is clicked (opens the adjustment panel). */
  onOpen?: () => void;
  className?: string;
}

/**
 * One design in a gallery.
 *
 * This is the card the Designs tab and the Design panel BOTH draw, so the
 * two tabs cannot drift apart: the user asked for the panel to look like the
 * first page, and the only reliable way to get that is to render the same
 * component twice.
 *
 * The body (the artwork) is the click target when `onOpen` is given. It is a
 * real `<button>`, so it is reachable by keyboard and announces itself - a
 * `div` with a click handler would be invisible to a keyboard user. Without
 * `onOpen` the body stays an inert div, exactly as the Designs tab had it,
 * so the tab order of a grid of fifty cards does not change.
 */
export function DesignCard({
  design,
  selected = false,
  showCheckbox = false,
  onToggle,
  swatches,
  colors,
  inkPair = false,
  onToggleInkPair,
  pairInfo,
  onSetInkRole,
  onUnpair,
  onOpen,
  className,
}: DesignCardProps): React.JSX.Element {
  /**
   * The swatches this card draws.
   *
   * `colors` narrows the row's swatches down to the ones THIS design is
   * printed on. Without it every swatch is drawn, which is what a caller
   * that does not know the per-design colours gets.
   */
  const shown = swatches
    ? colors && colors.length > 0
      ? swatches.filter((s) => colors.includes(s.name))
      : swatches
    : undefined;

  /** A paired design with no ink artwork at all cannot print its ink colours. */
  const missingInk = inkPair && !design.whiteInkAssetId && !design.blackInkAssetId;

  // The cutout when there is one, the original otherwise. No animation: a grid
  // of fifty cards moving is noise, not information.
  const artwork = (
    <div className="checkerboard relative aspect-square w-full overflow-hidden">
      <AssetThumb
        assetId={design.processedAssetId ?? design.originalAssetId}
        alt={design.name}
        className="absolute inset-0 h-full w-full object-contain"
      />
    </div>
  );

  return (
    <Card
      data-design-card={design.id}
      className={cn(
        "group relative min-w-0 overflow-hidden transition-shadow",
        selected && "ring-2 ring-forest",
        className,
      )}
    >
      <div className="relative">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${design.name}`}
            className="block w-full cursor-pointer"
          >
            {artwork}
          </button>
        ) : (
          artwork
        )}

        {showCheckbox && (
          // The box floats over the artwork, so it has to stop the click:
          // ticking a design for the batch must never open the design.
          <div
            className="absolute left-2 top-2"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={() => onToggle?.()}
              aria-label={`Select ${design.name}`}
              // The artwork behind the box can be white, so the box needs its
              // own edge to stay visible.
              className="border-ink-subtle bg-white/90 shadow-subtle"
            />
          </div>
        )}

        <div className="absolute right-2 top-2 flex max-w-[calc(100%-1rem)] flex-wrap justify-end gap-1">
          {design.processedAssetId && <Badge>cutout</Badge>}
          {design.whiteInkAssetId && <Badge>white ink</Badge>}
          {design.blackInkAssetId && <Badge>black ink</Badge>}
        </div>
      </div>

      <div className="min-w-0 space-y-1.5 border-t border-border-subtle px-3 py-2">
        <div className="truncate text-[13px] font-medium text-ink" title={design.name}>
          {design.name}
        </div>
        <div className="truncate text-[11px] text-ink-subtle">{design.dimensions}</div>
        {shown && shown.length > 0 && (
          <ColorSwatchRow swatches={shown} className="pt-0.5" />
        )}
        {onToggleInkPair && (
          <div className="flex items-center gap-1.5 pt-0.5">
            <Checkbox
              id={`ink-pair-${design.id}`}
              checked={inkPair}
              onCheckedChange={() => onToggleInkPair()}
              aria-label={`Ink variants for ${design.name}`}
              className="h-3.5 w-3.5"
            />
            <label
              htmlFor={`ink-pair-${design.id}`}
              className="cursor-pointer text-[11px] text-ink-muted"
            >
              Ink variants
            </label>
            {missingInk && !pairInfo && (
              <span className="text-[10px] text-warning" data-ink-missing="">
                make them first
              </span>
            )}
          </div>
        )}

        {pairInfo && onSetInkRole && (
          // The pair's role: WHICH design prints on the black-ink colours and
          // which on the white-ink ones. The two boxes behave as radios - a
          // design is one half of the pair, never both.
          <div className="space-y-1 pt-0.5" data-ink-pair-role="">
            <p
              className="truncate text-[10px] text-ink-subtle"
              title={`Paired with "${pairInfo.partnerName}"`}
            >
              Paired with “{pairInfo.partnerName}”
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="flex items-center gap-1">
                <Checkbox
                  id={`ink-role-black-${design.id}`}
                  checked={pairInfo.role === "black"}
                  onCheckedChange={() => onSetInkRole("black")}
                  aria-label={`${design.name} prints black ink`}
                  className="h-3.5 w-3.5"
                />
                <label
                  htmlFor={`ink-role-black-${design.id}`}
                  className="cursor-pointer text-[10.5px] text-ink-muted"
                >
                  Black ink
                </label>
              </span>
              <span className="flex items-center gap-1">
                <Checkbox
                  id={`ink-role-white-${design.id}`}
                  checked={pairInfo.role === "white"}
                  onCheckedChange={() => onSetInkRole("white")}
                  aria-label={`${design.name} prints white ink`}
                  className="h-3.5 w-3.5"
                />
                <label
                  htmlFor={`ink-role-white-${design.id}`}
                  className="cursor-pointer text-[10.5px] text-ink-muted"
                >
                  White ink
                </label>
              </span>
              {onUnpair && (
                <button
                  type="button"
                  onClick={onUnpair}
                  className="ml-auto cursor-pointer text-[10px] text-ink-subtle underline"
                >
                  Unpair
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
