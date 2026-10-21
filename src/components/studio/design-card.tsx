"use client";

import * as React from "react";
import { ColorSwatchRow } from "@/components/studio/color-swatch";
import { WaveCompare } from "@/components/studio/wave-compare";
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
  /** Stagger index for the wipe animation. */
  index?: number;
  paused?: boolean;
  selected?: boolean;
  /** Show the selection checkbox (the batch-scope picker). */
  showCheckbox?: boolean;
  onToggle?: () => void;
  /** The colour swatches this design's colours resolve to. */
  swatches?: Array<{ name: string; hex: string; ink?: "black" | "white" | "ambiguous" }>;
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
  index = 0,
  paused = false,
  selected = false,
  showCheckbox = false,
  onToggle,
  swatches,
  onOpen,
  className,
}: DesignCardProps): React.JSX.Element {
  const artwork = (
    <WaveCompare
      originalAssetId={design.originalAssetId}
      processedAssetId={design.processedAssetId}
      index={index}
      paused={paused}
      className="aspect-square w-full"
    />
  );

  return (
    <Card
      className={cn(
        "group relative overflow-hidden transition-shadow",
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

        <div className="absolute right-2 top-2 flex gap-1">
          {design.processedAssetId && <Badge>cutout</Badge>}
          {design.whiteInkAssetId && <Badge>white ink</Badge>}
          {design.blackInkAssetId && <Badge>black ink</Badge>}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border-subtle px-3 py-2">
        <div className="truncate text-[13px] font-medium text-ink" title={design.name}>
          {design.name}
        </div>
        <div className="text-[11px] text-ink-subtle">{design.dimensions}</div>
        {swatches && swatches.length > 0 && (
          <ColorSwatchRow swatches={swatches} className="pt-0.5" />
        )}
      </div>
    </Card>
  );
}
