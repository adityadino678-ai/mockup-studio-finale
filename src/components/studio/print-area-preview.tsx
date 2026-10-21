"use client";

import * as React from "react";
import type { StudioPlacement } from "@/types/domain";
import { cn } from "@/lib/utils";

interface PrintAreaPreviewProps {
  /** Object URL of the artwork to place. */
  artworkUrl: string | null;
  /** The artwork's natural pixel size. */
  artworkWidth: number;
  artworkHeight: number;
  /** The print area's pixel size. */
  areaWidth: number;
  areaHeight: number;
  placement: StudioPlacement;
  /** Called while dragging. Omit to make the preview read-only. */
  onChange?: (placement: StudioPlacement) => void;
  className?: string;
}

/**
 * A preview of the print area with the artwork placed on it.
 *
 * The artwork is drawn with Printify's own rules: `scale` is the artwork's
 * width as a fraction of the print area's width, and `x`/`y` are the CENTRE
 * of the artwork inside the area. The rectangle is the print area itself, in
 * the proportions Printify reports for the placeholder.
 *
 * The rectangle's position ON THE GARMENT is not shown: Printify does not
 * publish that, so showing a guess would be worse than showing the area.
 */
export function PrintAreaPreview({
  artworkUrl,
  artworkWidth,
  artworkHeight,
  areaWidth,
  areaHeight,
  placement,
  onChange,
  className,
}: PrintAreaPreviewProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const safeAreaW = areaWidth > 0 ? areaWidth : 3000;
  const safeAreaH = areaHeight > 0 ? areaHeight : 3000;
  const safeArtW = artworkWidth > 0 ? artworkWidth : 1;
  const safeArtH = artworkHeight > 0 ? artworkHeight : 1;

  // The artwork's height as a fraction of the area's height.
  const heightFraction =
    placement.scale * (safeArtH / safeArtW) * (safeAreaW / safeAreaH);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onChange) return;
    drag.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      startX: placement.x,
      startY: placement.y,
    };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || !onChange || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = state.startX + (event.clientX - state.pointerX) / rect.width;
    const y = state.startY + (event.clientY - state.pointerY) / rect.height;
    onChange({ ...placement, x: clamp(x), y: clamp(y) });
  };

  const stop = () => {
    drag.current = null;
  };

  /**
   * Keyboard equivalent of the drag: arrows move the artwork, Shift+arrows
   * change its size, Alt+arrows rotate it. Without this the preview - the
   * primary affordance - was reachable by pointer only.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onChange) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    let handled = true;
    switch (event.key) {
      case "ArrowLeft":
        onChange({ ...placement, x: clamp(placement.x - step) });
        break;
      case "ArrowRight":
        onChange({ ...placement, x: clamp(placement.x + step) });
        break;
      case "ArrowUp":
        onChange({ ...placement, y: clamp(placement.y - step) });
        break;
      case "ArrowDown":
        onChange({ ...placement, y: clamp(placement.y + step) });
        break;
      case "[":
        onChange({ ...placement, angle: placement.angle - 5 });
        break;
      case "]":
        onChange({ ...placement, angle: placement.angle + 5 });
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  const description = `Artwork at ${Math.round(placement.scale * 100)}% of the print area, centred at ${Math.round(placement.x * 100)}% across and ${Math.round(placement.y * 100)}% down, rotated ${Math.round(placement.angle)} degrees`;

  return (
    <div
      ref={ref}
      role="img"
      aria-label={description}
      tabIndex={onChange ? 0 : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      className={cn(
        "relative select-none overflow-hidden rounded-lg border border-border-strong bg-surface-muted",
        onChange ? "cursor-move touch-none" : "cursor-default",
        className,
      )}
      style={{ aspectRatio: `${safeAreaW} / ${safeAreaH}` }}
    >
      {artworkUrl && (
        <img
          src={artworkUrl}
          alt="Artwork preview"
          draggable={false}
          className="pointer-events-none absolute object-contain"
          style={{
            width: `${placement.scale * 100}%`,
            height: `${heightFraction * 100}%`,
            left: `${placement.x * 100}%`,
            top: `${placement.y * 100}%`,
            transform: `translate(-50%, -50%) rotate(${placement.angle}deg)`,
          }}
        />
      )}
      {/* The print area boundary, so the artwork's position is readable. */}
      <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-forest/35" />
    </div>
  );
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}
