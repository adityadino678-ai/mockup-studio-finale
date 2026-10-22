"use client";

// ---------------------------------------------------------------------------
// The print area editor.
//
// The mockup photo with the print area drawn on it and the design placed
// inside it, the way Printify would place it.
//
// The design is NOT free-floating: it is positioned by the Printify Studio's
// placement (`scale` = artwork width / area width, `x`/`y` = the artwork's
// CENTRE inside the area), so what is on screen is what the product gets.
//
// Gestures, all of them live edits that call back with a new placement:
//   * drag the artwork            -> move it (snaps to the centre and edges)
//   * drag the artwork's corner   -> resize it (uniform: Printify scales
//                                    artwork uniformly, so a stretched
//                                    artwork could never be printed)
//   * drag the rotate handle      -> rotate it (snaps to 15 degrees)
//   * drag the area               -> move the area on the photo
//   * drag the area's corner      -> resize the area (its aspect stays the
//                                    Printify area's aspect, always)
//   * drag across the photo       -> measure a reference line (optional)
// ---------------------------------------------------------------------------

import * as React from "react";
import type { MockupPrintArea, StudioPlacement } from "@/types/domain";
import { areaAspect } from "@/lib/mockups/print-area";
import { snapAngle, snapPosition } from "@/lib/printify/snap";
import { cn } from "@/lib/utils";

interface PrintAreaEditorProps {
  mockupUrl: string;
  mockupW: number;
  mockupH: number;
  /** The artwork to place, if the user picked one. */
  designUrl: string | null;
  designW: number;
  designH: number;
  /** The area being edited. Null means the mockup has no area yet. */
  area: MockupPrintArea | null;
  /** The Studio placement for the picked design. Null when none is picked. */
  placement: StudioPlacement | null;
  /** Live edit of the area (the box on the photo). */
  onAreaChange: (area: MockupPrintArea) => void;
  /** Live edit of the design's placement. */
  onPlacementChange: (placement: StudioPlacement) => void;
  /** Fired when a gesture ends. */
  onCommit?: () => void;
  /** When true, a drag across the photo measures a reference line. */
  measuring?: boolean;
  /** Reports a measured reference line, in photo pixels. */
  onMeasure?: (pixels: number) => void;
}

interface Point {
  x: number;
  y: number;
}

type Gesture =
  | { kind: "move-design"; pointerId: number; grabX: number; grabY: number; rawX: number; rawY: number }
  | { kind: "resize-design"; pointerId: number; startScale: number; startX: number }
  | { kind: "rotate-design"; pointerId: number; baseAngle: number; accumulated: number; lastAngle: number }
  | { kind: "move-area"; pointerId: number; grabX: number; grabY: number; rawX: number; rawY: number }
  | { kind: "resize-area"; pointerId: number; startWidth: number; startX: number }
  | { kind: "measure"; pointerId: number; start: Point };

/** How far one arrow key moves the design, as a fraction of the area. */
const MOVE_STEP = 0.01;
/** How far one Shift+arrow resizes the design, as a fraction of the area. */
const SCALE_STEP = 0.01;
/** How far one Alt+arrow rotates the design, in degrees. */
const ROTATE_STEP = 5;

export function PrintAreaEditor({
  mockupUrl,
  mockupW,
  mockupH,
  designUrl,
  designW,
  designH,
  area,
  placement,
  onAreaChange,
  onPlacementChange,
  onCommit,
  measuring = false,
  onMeasure,
}: PrintAreaEditorProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const gestureRef = React.useRef<Gesture | null>(null);
  const measureRef = React.useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [guides, setGuides] = React.useState({ x: false, y: false });
  const [badge, setBadge] = React.useState<string | null>(null);
  const [measureLine, setMeasureLine] = React.useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const aspect = area ? areaAspect(area) : 1;
  const artAspect = designW > 0 && designH > 0 ? designH / designW : 1;
  /** The photo's on-screen height, from its width and the mockup's shape. */
  const photoHeight = containerWidth > 0 ? (mockupH * containerWidth) / mockupW : 0;

  // The area box, in screen pixels.
  const boxScreen = React.useMemo(() => {
    if (!area || containerWidth === 0 || photoHeight === 0) return null;
    const width = area.box.width * containerWidth;
    const height = width * aspect;
    const left = (area.box.x - area.box.width / 2) * containerWidth;
    const top = (area.box.y - height / photoHeight / 2) * photoHeight;
    return { width, height, left, top };
  }, [area, containerWidth, photoHeight, aspect]);

  // The artwork's rectangle inside the area, in screen pixels.
  const artScreen = React.useMemo(() => {
    if (!boxScreen || !placement) return null;
    const width = boxScreen.width * placement.scale;
    const height = width * artAspect;
    const cx = boxScreen.left + placement.x * boxScreen.width;
    const cy = boxScreen.top + placement.y * boxScreen.height;
    return { width, height, cx, cy };
  }, [boxScreen, placement, artAspect]);

  const pointerIn = (event: React.PointerEvent): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const action = target?.closest?.("[data-gesture]")?.getAttribute("data-gesture");
    if (!action) return;
    if (action === "measure" && !measuring) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* no capture available - the move handler still works */
    }
    const point = pointerIn(event);

    if (action === "measure") {
      gestureRef.current = { kind: "measure", pointerId: event.pointerId, start: point };
      const line = { x1: point.x, y1: point.y, x2: point.x, y2: point.y };
      measureRef.current = line;
      setMeasureLine(line);
      return;
    }

    if (action === "move-area" && area && boxScreen) {
      gestureRef.current = {
        kind: "move-area",
        pointerId: event.pointerId,
        grabX: point.x - boxScreen.left,
        grabY: point.y - boxScreen.top,
        rawX: area.box.x,
        rawY: area.box.y,
      };
      return;
    }

    if (action === "resize-area" && area) {
      gestureRef.current = {
        kind: "resize-area",
        pointerId: event.pointerId,
        startWidth: area.box.width,
        startX: point.x,
      };
      return;
    }

    if (!artScreen || !boxScreen || !placement) return;

    if (action === "move-design") {
      gestureRef.current = {
        kind: "move-design",
        pointerId: event.pointerId,
        grabX: point.x - artScreen.cx,
        grabY: point.y - artScreen.cy,
        rawX: placement.x,
        rawY: placement.y,
      };
      return;
    }

    if (action === "resize-design") {
      gestureRef.current = {
        kind: "resize-design",
        pointerId: event.pointerId,
        startScale: placement.scale,
        startX: point.x,
      };
      return;
    }

    if (action === "rotate-design") {
      gestureRef.current = {
        kind: "rotate-design",
        pointerId: event.pointerId,
        baseAngle: placement.angle,
        accumulated: 0,
        lastAngle: pointerAngle(point.x, point.y, artScreen.cx, artScreen.cy),
      };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const point = pointerIn(event);

    if (gesture.kind === "measure") {
      const line = { x1: gesture.start.x, y1: gesture.start.y, x2: point.x, y2: point.y };
      measureRef.current = line;
      setMeasureLine(line);
      return;
    }

    if (gesture.kind === "move-area" && area && boxScreen && containerWidth > 0 && photoHeight > 0) {
      const x = gesture.rawX + (point.x - gesture.grabX) / containerWidth;
      const y = gesture.rawY + (point.y - gesture.grabY) / photoHeight;
      onAreaChange({
        ...area,
        box: { ...area.box, x: clamp(x, 0, 1), y: clamp(y, 0, 1) },
      });
      return;
    }

    if (gesture.kind === "resize-area" && area && containerWidth > 0) {
      // The area keeps the Printify area's aspect: only its width is free.
      // The width changes by twice the drag so the corner follows the pointer
      // while the box's centre stays where it was.
      const delta = (point.x - gesture.startX) / containerWidth;
      onAreaChange({
        ...area,
        box: { ...area.box, width: clamp(gesture.startWidth + delta * 2, 0.05, 1) },
      });
      return;
    }

    const current = placement;
    if (!current || !artScreen || !boxScreen) return;

    if (gesture.kind === "move-design") {
      const rawX = gesture.rawX + (point.x - gesture.grabX) / boxScreen.width;
      const rawY = gesture.rawY + (point.y - gesture.grabY) / boxScreen.height;
      const snapped = snapPosition({
        x: rawX,
        y: rawY,
        scale: current.scale,
        artAspect,
        areaWidth: boxScreen.width,
        areaHeight: boxScreen.height,
        mode: "all",
      });
      onPlacementChange({ ...current, x: clamp(snapped.x, 0, 1), y: clamp(snapped.y, 0, 1) });
      setGuides({ x: snapped.snappedX, y: snapped.snappedY });
      setBadge(snapped.label ?? null);
      return;
    }

    if (gesture.kind === "resize-design") {
      // Uniform: the artwork keeps its own aspect ratio, because that is the
      // only thing Printify can print.
      const delta = (point.x - gesture.startX) / boxScreen.width;
      onPlacementChange({ ...current, scale: clamp(gesture.startScale + delta * 2, 0.01, 4) });
      return;
    }

    if (gesture.kind === "rotate-design") {
      const angle = pointerAngle(point.x, point.y, artScreen.cx, artScreen.cy);
      gesture.accumulated += shortestDelta(angle, gesture.lastAngle);
      gesture.lastAngle = angle;
      const next = gesture.baseAngle + gesture.accumulated;
      if (event.shiftKey) {
        onPlacementChange({ ...placement, angle: normalise(next) });
        setBadge(null);
      } else {
        const snapped = snapAngle(next);
        onPlacementChange({ ...placement, angle: snapped.angle });
        setBadge(snapped.snapped ? (snapped.label ?? null) : null);
      }
    }
  };

  const onPointerUp = () => {
    const gesture = gestureRef.current;
    const line = measureRef.current;
    if (gesture?.kind === "measure" && line) {
      const pixels = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
      const photoPixels = pixels * (mockupW / Math.max(1, containerWidth));
      onMeasure?.(Math.round(photoPixels));
    }
    measureRef.current = null;
    setMeasureLine(null);
    gestureRef.current = null;
    setGuides({ x: false, y: false });
    setBadge(null);
    onCommit?.();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!area || !placement) return;
    const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (horizontal === 0 && vertical === 0) return;
    event.preventDefault();

    if (event.altKey) {
      onPlacementChange({
        ...placement,
        angle: normalise(placement.angle + (horizontal || vertical) * ROTATE_STEP),
      });
      return;
    }
    if (event.shiftKey) {
      onPlacementChange({
        ...placement,
        scale: Math.max(0.01, placement.scale + horizontal * SCALE_STEP),
      });
      return;
    }
    const snapped = snapPosition({
      x: clamp(placement.x + horizontal * MOVE_STEP, 0, 1),
      y: clamp(placement.y + vertical * MOVE_STEP, 0, 1),
      scale: placement.scale,
      artAspect,
      areaWidth: boxScreen?.width ?? 1,
      areaHeight: boxScreen?.height ?? 1,
      mode: "all",
    });
    onPlacementChange({ ...placement, x: snapped.x, y: snapped.y });
    setGuides({ x: snapped.snappedX, y: snapped.snappedY });
  };

  const pct = (value: number, total: number) => (total > 0 ? (value / total) * 100 : 0);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full select-none overflow-hidden rounded-lg border border-border-subtle bg-surface-muted",
        measuring ? "cursor-crosshair" : "cursor-default",
      )}
      style={{ aspectRatio: `${mockupW} / ${mockupH}` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="application"
      aria-label="Print area editor"
    >
      <img
        src={mockupUrl}
        alt=""
        draggable={false}
        className="pointer-events-none block h-full w-full object-contain"
      />

      {area && boxScreen ? (
        <>
          {/* The print area. Everything outside it is cut off - the design is
              clipped here, which is exactly what the product does. */}
          <div
            className="pointer-events-none absolute overflow-hidden"
            style={{
              left: `${pct(boxScreen.left, containerWidth)}%`,
              top: `${pct(boxScreen.top, photoHeight)}%`,
              width: `${pct(boxScreen.width, containerWidth)}%`,
              height: `${pct(boxScreen.height, photoHeight)}%`,
            }}
          >
            {designUrl && placement ? (
              <img
                src={designUrl}
                alt=""
                draggable={false}
                className="pointer-events-none absolute select-none"
                style={{
                  left: `${placement.x * 100}%`,
                  top: `${placement.y * 100}%`,
                  width: `${placement.scale * 100}%`,
                  transform: `translate(-50%, -50%) rotate(${placement.angle}deg)`,
                  transformOrigin: "center",
                }}
              />
            ) : null}
          </div>

          {/* The area's outline, above the artwork. */}
          <div
            data-gesture="move-area"
            className="absolute cursor-move"
            style={{
              left: `${pct(boxScreen.left, containerWidth)}%`,
              top: `${pct(boxScreen.top, photoHeight)}%`,
              width: `${pct(boxScreen.width, containerWidth)}%`,
              height: `${pct(boxScreen.height, photoHeight)}%`,
              border: "2px dashed rgba(49,77,61,.85)",
              borderRadius: 3,
              boxShadow: "0 0 0 1px rgba(255,255,255,.45) inset",
            }}
          >
            <span
              className="absolute -top-[11px] left-0 whitespace-nowrap rounded bg-forest px-1.5 py-[1px] text-[10px] font-semibold text-white"
              title="Drag to move the print area"
            >
              {area.label} · {area.areaWidth} × {area.areaHeight}
            </span>
            <span
              data-gesture="resize-area"
              className="absolute -bottom-[6px] -right-[6px] h-3 w-3 cursor-nwse-resize rounded-[3px] border-2 border-forest bg-white"
              title="Drag to resize the area (its shape stays the Printify area's shape)"
            />
          </div>

          {designUrl && placement && artScreen ? (
            <>
              <div
                data-gesture="move-design"
                className="absolute cursor-grab active:cursor-grabbing"
                style={{
                  left: `${pct(artScreen.cx - artScreen.width / 2, containerWidth)}%`,
                  top: `${pct(artScreen.cy - artScreen.height / 2, photoHeight)}%`,
                  width: `${pct(artScreen.width, containerWidth)}%`,
                  height: `${pct(artScreen.height, photoHeight)}%`,
                  outline: "1px dashed rgba(255,255,255,.9)",
                  transform: `rotate(${placement.angle}deg)`,
                  transformOrigin: "center",
                }}
              />
              <div
                data-gesture="rotate-design"
                className="absolute cursor-grab"
                style={{
                  left: `${pct(artScreen.cx, containerWidth)}%`,
                  top: `${pct(artScreen.cy, photoHeight)}%`,
                  width: 14,
                  height: 14,
                  marginLeft: -7,
                  marginTop: -pct(artScreen.height / 2, photoHeight) - 26,
                  borderRadius: 99,
                  background: "var(--forest)",
                  border: "2px solid #fff",
                }}
                title="Drag to rotate"
              />
              <div
                data-gesture="resize-design"
                className="absolute cursor-nwse-resize rounded-[3px] border-2 border-forest bg-white"
                style={{
                  left: `${pct(artScreen.cx + artScreen.width / 2, containerWidth)}%`,
                  top: `${pct(artScreen.cy + artScreen.height / 2, photoHeight)}%`,
                  width: 12,
                  height: 12,
                  marginLeft: -6,
                  marginTop: -6,
                }}
                title="Drag to resize (uniform)"
              />
            </>
          ) : null}

          {guides.x && placement ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute w-[1.5px] bg-[#e0483c]"
              style={{
                left: `${pct(boxScreen.left + placement.x * boxScreen.width, containerWidth)}%`,
                top: 0,
                bottom: 0,
              }}
            />
          ) : null}
          {guides.y && placement ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute h-[1.5px] bg-[#e0483c]"
              style={{
                top: `${pct(boxScreen.top + placement.y * boxScreen.height, photoHeight)}%`,
                left: 0,
                right: 0,
              }}
            />
          ) : null}
        </>
      ) : null}

      {measureLine ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-[2px] origin-left bg-[#e0483c]"
          style={{
            left: `${pct(measureLine.x1, containerWidth)}%`,
            top: `${pct(measureLine.y1, photoHeight)}%`,
            width: `${pct(Math.hypot(measureLine.x2 - measureLine.x1, measureLine.y2 - measureLine.y1), containerWidth)}%`,
            transform: `rotate(${Math.atan2(measureLine.y2 - measureLine.y1, measureLine.x2 - measureLine.x1)}rad)`,
          }}
        />
      ) : null}

      {badge ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full bg-forest px-2 py-[2px] text-[10.5px] font-semibold whitespace-nowrap text-white"
          style={{ left: "calc(50% + 10px)", top: "calc(50% - 26px)" }}
        >
          {badge}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pointer maths.
// ---------------------------------------------------------------------------

function pointerAngle(x: number, y: number, cx: number, cy: number): number {
  return (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
}

function shortestDelta(to: number, from: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function normalise(angle: number): number {
  const wrapped = ((angle % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
