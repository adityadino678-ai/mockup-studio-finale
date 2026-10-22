"use client";

import * as React from "react";
import type { StudioPlacement } from "@/types/domain";
import { cn } from "@/lib/utils";
import { snapAngle, snapPosition, type SnapMode } from "@/lib/printify/snap";

export interface PrintAreaPreviewProps {
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
  /** Which guides the artwork may snap to. Defaults to "all". */
  snapMode?: SnapMode;
  className?: string;
}

/** Diameter of the round rotation handle, in screen pixels. */
const HANDLE_SIZE = 26;

/**
 * Gap between the artwork's edge and the rotation handle's edge, in screen
 * pixels. The handle's radius is half of `HANDLE_SIZE`, so the handle's centre
 * sits `HANDLE_GAP + HANDLE_SIZE / 2` beyond the artwork's edge.
 */
const HANDLE_GAP = 22;

/** How far one arrow key press moves the artwork, as a fraction of the area. */
const MOVE_STEP = 0.01;

/** How far one Shift+arrow press resizes the artwork, as a fraction of the area. */
const SCALE_STEP = 0.01;

/** How far one Alt+arrow press rotates the artwork, in degrees. */
const ROTATE_STEP = 5;

type DragState =
  | {
      mode: "move";
      pointerId: number;
      /**
       * Where the pointer grabbed the artwork, relative to the artwork's
       * centre, in container pixels. Without it the artwork would jump so
       * that its centre is under the pointer the moment the drag starts.
       */
      grabX: number;
      grabY: number;
      /** The unsnapped position under the pointer, for the keyboard to resume from. */
      rawX: number;
      rawY: number;
    }
  | {
      mode: "rotate";
      pointerId: number;
      /** The artwork's rotation when the drag began. */
      baseAngle: number;
      /** Rotation accumulated so far, in degrees. */
      accumulated: number;
      /** The pointer's angle around the artwork's centre on the last move. */
      lastPointerAngle: number;
    };

/**
 * The print area with the artwork placed on it, Printify-style.
 *
 * The artwork is drawn with Printify's own rules: `scale` is the artwork's
 * width as a fraction of the print area's width, and `x`/`y` are the CENTRE
 * of the artwork inside the area. The rectangle is the print area itself, in
 * the proportions Printify reports for the placeholder.
 *
 * The user can drag the artwork, drag the round handle to rotate it, and the
 * artwork snaps to the centre of the area, to its edges and to 15 degree
 * rotation steps. Holding Shift gives a free move (or a free rotate).
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
  snapMode = "all",
  className,
}: PrintAreaPreviewProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  /**
   * The print area's on-screen box, in the container's CONTENT box
   * coordinates - the same space the artwork's `left: 50%` and the handle's
   * `left`/`top` live in. The border is excluded so the placement fractions
   * map exactly onto the drawn pixels, and the snap thresholds (which are
   * screen pixels) mean the same thing at any zoom.
   */
  const [box, setBox] = React.useState({ width: 0, height: 0, insetLeft: 0, insetTop: 0 });
  /** Which guides to draw while the artwork is snapped. */
  const [guides, setGuides] = React.useState({ x: false, y: false });
  /** The badge naming what the artwork snapped to. */
  const [badge, setBadge] = React.useState<string | null>(null);
  /** True while the rotation handle is being dragged. */
  const [rotating, setRotating] = React.useState(false);

  /**
   * The artwork's UNSNAPPED position. The keyboard moves it from here, so
   * holding an arrow key walks the artwork out of a snapped position instead
   * of gluing it to the centre line. It is re-synced whenever the placement
   * changes for a reason other than our own snapping.
   */
  const rawRef = React.useRef({ x: placement.x, y: placement.y });
  /** The last position this component emitted, to tell our own echo apart. */
  const emittedRef = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    const emitted = emittedRef.current;
    if (emitted && emitted.x === placement.x && emitted.y === placement.y) return;
    rawRef.current = { x: placement.x, y: placement.y };
  }, [placement.x, placement.y]);

  /** Emits a placement and remembers it, so our own snapping is not undone. */
  const emit = React.useCallback(
    (next: StudioPlacement) => {
      emittedRef.current = { x: next.x, y: next.y };
      onChange?.(next);
    },
    [onChange],
  );

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const style = window.getComputedStyle(el);
      const insetLeft = parseFloat(style.borderLeftWidth) || 0;
      const insetTop = parseFloat(style.borderTopWidth) || 0;
      const width = el.clientWidth;
      const height = el.clientHeight;
      setBox((prev) =>
        Math.abs(prev.width - width) < 0.01 &&
        Math.abs(prev.height - height) < 0.01 &&
        Math.abs(prev.insetLeft - insetLeft) < 0.01 &&
        Math.abs(prev.insetTop - insetTop) < 0.01
          ? prev
          : { width, height, insetLeft, insetTop },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const safeAreaW = areaWidth > 0 ? areaWidth : 3000;
  const safeAreaH = areaHeight > 0 ? areaHeight : 3000;
  /** The artwork's own aspect, so the artwork is never stretched. */
  const artAspect = artworkWidth > 0 && artworkHeight > 0 ? artworkHeight / artworkWidth : 1;
  const scale = placement.scale > 0 ? placement.scale : 0.01;

  // The artwork's drawn size in screen pixels. Its width is the area's width
  // times the placement's scale, and its height follows from the artwork's
  // real aspect ratio, so the drag maths, the rotation maths and the handle
  // all agree on where the artwork's edges are.
  const drawnWidth = scale * box.width;
  const drawnHeight = drawnWidth * artAspect;

  // The artwork's centre inside the container, in screen pixels.
  const centreX = placement.x * box.width;
  const centreY = placement.y * box.height;

  // The rotation handle sits just beyond the artwork's top edge, IN THE
  // ARTWORK'S OWN FRAME: the local "up" direction (0, -1) rotated by the
  // placement's angle. At 90 degrees that points to the right, so the handle
  // ends up on the artwork's right edge.
  const handleRadius = (drawnHeight / 2 + HANDLE_GAP + HANDLE_SIZE / 2);
  const angleRad = (placement.angle * Math.PI) / 180;
  // The handle is kept INSIDE the preview: artwork wider or taller than the
  // print area would otherwise push it over the controls, or off the panel.
  const handleHalf = HANDLE_SIZE / 2 + 2;
  const handleX = clamp(
    centreX + Math.sin(angleRad) * handleRadius,
    handleHalf,
    Math.max(handleHalf, box.width - handleHalf),
  );
  const handleY = clamp(
    centreY - Math.cos(angleRad) * handleRadius,
    handleHalf,
    Math.max(handleHalf, box.height - handleHalf),
  );

  const containerRect = () => containerRef.current?.getBoundingClientRect() ?? null;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onChange) return;
    const target = event.target as HTMLElement | null;
    const onHandle = Boolean(target?.closest?.("[data-rotate-handle]"));
    const onArtwork = Boolean(target?.closest?.("[data-artwork]"));
    if (!onHandle && !onArtwork) return;

    const rect = containerRect();
    if (!rect || box.width === 0 || box.height === 0) return;
    event.preventDefault();
    // Synthetic pointer events (and some browsers) have no capturable
    // pointer, so a failure here must not break the drag.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* no capture available - the move handler still works */
    }

    // The pointer in the container's content-box coordinates.
    const pointerX = event.clientX - rect.left - box.insetLeft;
    const pointerY = event.clientY - rect.top - box.insetTop;
    const artCentreX = placement.x * box.width;
    const artCentreY = placement.y * box.height;

    if (onHandle) {
      dragRef.current = {
        mode: "rotate",
        pointerId: event.pointerId,
        baseAngle: placement.angle,
        accumulated: 0,
        lastPointerAngle: pointerAngleOf(pointerX, pointerY, artCentreX, artCentreY),
      };
      setRotating(true);
    } else {
      dragRef.current = {
        mode: "move",
        pointerId: event.pointerId,
        grabX: pointerX - artCentreX,
        grabY: pointerY - artCentreY,
        rawX: placement.x,
        rawY: placement.y,
      };
    }
    setGuides({ x: false, y: false });
    setBadge(null);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !onChange) return;
    const rect = containerRect();
    if (!rect || box.width === 0 || box.height === 0) return;

    // Shift gives a free move (and a free rotate): the snapping is off.
    const free = event.shiftKey;
    const pointerX = event.clientX - rect.left - box.insetLeft;
    const pointerY = event.clientY - rect.top - box.insetTop;

    if (drag.mode === "move") {
      const rawX = (pointerX - drag.grabX) / box.width;
      const rawY = (pointerY - drag.grabY) / box.height;
      drag.rawX = rawX;
      drag.rawY = rawY;
      if (free) {
        emit({ ...placement, x: clamp01(rawX), y: clamp01(rawY) });
        setGuides({ x: false, y: false });
        setBadge(null);
        return;
      }
      const snapped = snapPosition({
        x: rawX,
        y: rawY,
        scale,
        artAspect,
        areaWidth: box.width,
        areaHeight: box.height,
        mode: snapMode,
      });
      emit({ ...placement, x: clamp01(snapped.x), y: clamp01(snapped.y) });
      setGuides({ x: snapped.snappedX, y: snapped.snappedY });
      setBadge(snapped.label ?? null);
      return;
    }

    const artCentreX = placement.x * box.width;
    const artCentreY = placement.y * box.height;
    const pointerAngle = pointerAngleOf(pointerX, pointerY, artCentreX, artCentreY);
    // Accumulate the shortest step so that crossing the +/-180 degree seam
    // does not spin the artwork a whole turn.
    drag.accumulated += shortestAngleDelta(pointerAngle, drag.lastPointerAngle);
    drag.lastPointerAngle = pointerAngle;

    let next = drag.baseAngle + drag.accumulated;
    if (free) {
      next = normaliseAngle(next);
      setGuides({ x: false, y: false });
      setBadge(null);
    } else {
      const snapped = snapAngle(next);
      next = snapped.angle;
      setGuides({ x: false, y: false });
      setBadge(snapped.snapped ? (snapped.label ?? null) : null);
    }
    emit({ ...placement, angle: next });
  };
  const stopDragging = () => {
    const drag = dragRef.current;
    if (drag && drag.mode === "move") {
      // The keyboard resumes from where the drag left the artwork, not from
      // the snapped position it is showing.
      rawRef.current = { x: drag.rawX, y: drag.rawY };
    }
    dragRef.current = null;
    setRotating(false);
    setGuides({ x: false, y: false });
    setBadge(null);
  };

  /**
   * Keyboard equivalent of the pointer gestures: arrows move the artwork
   * (with snapping), Shift+arrows resize it, Alt+arrows rotate it. Without
   * this the preview - the primary affordance - was reachable by pointer only.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onChange) return;
    const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (horizontal === 0 && vertical === 0) {
      // [ and ] rotate, kept from the previous version of this component.
      if (event.key === "[") {
        event.preventDefault();
        emit({ ...placement, angle: normaliseAngle(placement.angle - ROTATE_STEP) });
      } else if (event.key === "]") {
        event.preventDefault();
        emit({ ...placement, angle: normaliseAngle(placement.angle + ROTATE_STEP) });
      }
      return;
    }
    event.preventDefault();

    if (event.altKey) {
      const direction = horizontal !== 0 ? horizontal : vertical;
      const raw = placement.angle + direction * ROTATE_STEP;
      if (event.shiftKey) {
        emit({ ...placement, angle: normaliseAngle(raw) });
        setGuides({ x: false, y: false });
        setBadge(null);
        return;
      }
      const snapped = snapAngle(raw);
      emit({ ...placement, angle: snapped.angle });
      setGuides({ x: false, y: false });
      setBadge(snapped.snapped ? (snapped.label ?? null) : null);
      return;
    }

    if (event.shiftKey) {
      const next = Math.max(0.01, scale + horizontal * SCALE_STEP);
      emit({ ...placement, scale: next });
      return;
    }

    // The move starts from the artwork's UNSNAPPED position, so holding an
    // arrow key walks it away from a snapped position instead of leaving it
    // stuck on the centre line.
    const rawX = clamp01(rawRef.current.x + horizontal * MOVE_STEP);
    const rawY = clamp01(rawRef.current.y + vertical * MOVE_STEP);
    rawRef.current = { x: rawX, y: rawY };
    if (box.width === 0 || box.height === 0) {
      emit({ ...placement, x: rawX, y: rawY });
      return;
    }
    const snapped = snapPosition({
      x: rawX,
      y: rawY,
      scale,
      artAspect,
      areaWidth: box.width,
      areaHeight: box.height,
      mode: snapMode,
    });
    emit({ ...placement, x: clamp01(snapped.x), y: clamp01(snapped.y) });
    setGuides({ x: snapped.snappedX, y: snapped.snappedY });
    setBadge(snapped.label ?? null);
  };

  const description = `Artwork at ${Math.round(placement.scale * 100)}% of the print area, centred at ${Math.round(placement.x * 100)}% across and ${Math.round(placement.y * 100)}% down, rotated ${Math.round(placement.angle)} degrees`;

  const measured = box.width > 0 && box.height > 0;

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={description}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      className={cn(
        "relative select-none rounded-lg border border-border-strong bg-surface-muted",
        onChange ? "cursor-move touch-none" : "cursor-default",
        className,
      )}
      style={{ aspectRatio: `${safeAreaW} / ${safeAreaH}` }}
    >
      {/* The print area boundary, so the artwork's position is readable. */}
      <div className="pointer-events-none absolute inset-0 rounded-lg border-2 border-dashed border-forest/35" />

      {artworkUrl && measured && (
        // The artwork is clipped to the print area. Printify CROPS anything
        // outside the placeholder, so drawing it beyond the dashed frame
        // would promise a print the buyer never gets - and a tall design at a
        // large scale used to paint straight over the panel's controls.
        // Guides, snap badge and rotation handle stay OUTSIDE this layer.
        <div className="absolute inset-0 overflow-hidden rounded-lg">
          <div
            data-artwork=""
            className={cn(
              "absolute",
              onChange ? "cursor-grab active:cursor-grabbing" : "cursor-default",
            )}
            style={{
              left: "50%",
              top: "50%",
              width: `${drawnWidth}px`,
              height: `${drawnHeight}px`,
              // The artwork is centred by its OWN size first, then moved by the
              // placement offset, then rotated about its centre. Offsetting the
              // element with `left`/`top` as well would count the offset twice
              // and throw the artwork out of the print area.
              transform: `translate(-50%, -50%) translate(${(placement.x - 0.5) * box.width}px, ${(placement.y - 0.5) * box.height}px) rotate(${placement.angle}deg)`,
            }}
          >
            <img
              src={artworkUrl}
              alt=""
              draggable={false}
              className="pointer-events-none h-full w-full select-none object-contain"
            />
            {/* The artwork's own bounds, so the edge snapping is visible. */}
            <div className="pointer-events-none absolute inset-0 border border-dashed border-forest/45" />
          </div>
        </div>
      )}

      {/* Symmetry guides: a thin red line through the middle of the area. */}
      {guides.x && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 w-[1.5px] bg-[#e0483c]"
          style={{ left: "calc(50% - 0.75px)", top: -10, bottom: -10 }}
        />
      )}
      {guides.y && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 h-[1.5px] bg-[#e0483c]"
          style={{ top: "calc(50% - 0.75px)", left: -10, right: -10 }}
        />
      )}

      {/* The stem from the artwork's centre to the rotation handle. */}
      {rotating && measured && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 bg-forest/45"
          style={{
            left: `${centreX}px`,
            top: `${centreY}px`,
            width: 1.5,
            height: `${Math.hypot(handleX - centreX, handleY - centreY)}px`,
            transform: `rotate(${Math.atan2(handleY - centreY, handleX - centreX)}rad)`,
            transformOrigin: "top center",
          }}
        />
      )}

      {/* The rotation handle, on the artwork's rotated top edge. */}
      {onChange && artworkUrl && measured && (
        <div
          data-rotate-handle=""
          aria-hidden="true"
          className="absolute z-20 grid place-items-center rounded-full border-2 border-forest bg-surface shadow-card"
          style={{
            left: `${handleX}px`,
            top: `${handleY}px`,
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            marginLeft: -HANDLE_SIZE / 2,
            marginTop: -HANDLE_SIZE / 2,
            cursor: "grab",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            className="h-[13px] w-[13px] text-forest"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <path d="M21 3v6h-6" />
          </svg>
        </div>
      )}

      {/* What the artwork snapped to. Decorative: the label above says it. */}
      {badge && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-30 rounded-full bg-forest px-2 py-[2px] text-[10.5px] font-semibold whitespace-nowrap text-white"
          style={{ left: "calc(50% + 10px)", top: "calc(50% - 26px)" }}
        >
          {badge}
        </div>
      )}
    </div>
  );
}

/** The pointer's angle around the artwork's centre, in degrees. */
function pointerAngleOf(
  pointerX: number,
  pointerY: number,
  centreX: number,
  centreY: number,
): number {
  return (Math.atan2(pointerY - centreY, pointerX - centreX) * 180) / Math.PI;
}

/** The shortest signed distance from `from` to `to`, in degrees. */
function shortestAngleDelta(to: number, from: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

/**
 * Normalises an angle in degrees to (-180, 180], which is the range the
 * studio's rotation slider uses - a larger value would be clamped away by
 * the slider and the artwork would appear to jump.
 */
function normaliseAngle(angle: number): number {
  const wrapped = ((angle % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** Limits a screen-pixel value to a range, keeping the handle on screen. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
