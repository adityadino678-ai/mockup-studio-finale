"use client";

// ---------------------------------------------------------------------------
// The print area canvas.
//
// Konva, for the same reason the old editor used it: Konva moves the
// nodes IMPERATIVELY while the pointer is down, and React is only told at the
// end. A DOM overlay has to re-render on every pointer move, and the whole
// panel re-renders with it, which is what makes it feel sticky.
//
// The scene:
//
//   * the mockup photo
//   * the FRAME - a group that is positioned, scaled and rotated on the photo,
//     and that CLIPS the artwork inside it. The artwork is the Printify
//     Studio's placement, in the frame's local space, so it is carried by the
//     frame: move the frame and the design moves, scale the frame and the
//     design scales, rotate the frame and the design rotates.
//   * the frame's chrome: the dashed outline and the handles. Clicking the
//     empty photo hides it; the artwork stays.
//
// The artwork has NO drag handler: the design is not moveable here. Its
// placement belongs to the Printify Studio.
// ---------------------------------------------------------------------------

import * as React from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Group, Transformer, Line, Circle } from "react-konva";
import type Konva from "konva";
import type { MockupPrintArea, StudioPlacement } from "@/types/domain";
import {
  areaCrop,
  areaPointFromMockup,
  areaPointInMockup,
  clipFor,
  cropLocalRect,
  describeCrop,
  frameToPixels,
  isFullCrop,
  MIN_CROP,
  type AreaCrop,
} from "@/lib/mockups/print-area";
import { cn } from "@/lib/utils";

/** Which edge or corner of the crop window a handle drags. */
type CropAnchor = "nw" | "n" | "ne" | "w" | "e" | "sw" | "s" | "se";

const CROP_ANCHORS: Array<{ id: CropAnchor; u: number; v: number }> = [
  { id: "nw", u: 0, v: 0 },
  { id: "n", u: 0.5, v: 0 },
  { id: "ne", u: 1, v: 0 },
  { id: "w", u: 0, v: 0.5 },
  { id: "e", u: 1, v: 0.5 },
  { id: "sw", u: 0, v: 1 },
  { id: "s", u: 0.5, v: 1 },
  { id: "se", u: 1, v: 1 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The crop after a drag.
 *
 * `du`/`dv` are the pointer's movement in the AREA's own fractions, so the
 * gesture follows the frame's rotation. A body drag moves the window; a
 * handle drag moves only the edges it names, and the opposite edge stays put.
 */
function applyCropDrag(
  start: AreaCrop,
  handle: CropAnchor | null,
  du: number,
  dv: number,
): AreaCrop {
  if (!handle) {
    return {
      ...start,
      x: clamp(start.x + du, 0, 1 - start.width),
      y: clamp(start.y + dv, 0, 1 - start.height),
    };
  }
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes("w")) left = clamp(start.x + du, 0, right - MIN_CROP);
  if (handle.includes("e")) right = clamp(right + du, left + MIN_CROP, 1);
  if (handle.includes("n")) top = clamp(start.y + dv, 0, bottom - MIN_CROP);
  if (handle.includes("s")) bottom = clamp(bottom + dv, top + MIN_CROP, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

interface PrintAreaCanvasProps {
  mockupUrl: string;
  mockupW: number;
  mockupH: number;
  designUrl: string | null;
  designW: number;
  designH: number;
  /** The area being edited. Null means the mockup has no area yet. */
  area: MockupPrintArea | null;
  /** The Studio placement for the picked design. */
  placement: StudioPlacement | null;
  /** When true, a drag across the photo measures a reference line. */
  measuring?: boolean;
  /** When true, the handles crop the visible window instead of staging. */
  cropMode?: boolean;
  /** Live edit of the area (the frame on the photo). */
  onAreaChange: (area: MockupPrintArea) => void;
  /**
   * Live edit of the crop window. `undefined` means the whole area, which is
   * what a "Whole area" reset passes.
   */
  onCropChange?: (crop: AreaCrop | undefined) => void;
  /** Fired when a gesture ends. */
  onCommit?: () => void;
  /** Reports a measured reference line, in photo pixels. */
  onMeasure?: (pixels: number) => void;
}

function useHtmlImage(url: string | null): HTMLImageElement | null {
  const [img, setImg] = React.useState<HTMLImageElement | null>(null);
  React.useEffect(() => {
    if (!url) {
      setImg(null);
      return;
    }
    const image = new Image();
    let cancelled = false;
    image.onload = () => {
      if (!cancelled) setImg(image);
    };
    image.onerror = () => {
      if (!cancelled) setImg(null);
    };
    image.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return img;
}

export function PrintAreaCanvas({
  mockupUrl,
  mockupW,
  mockupH,
  designUrl,
  designW,
  designH,
  area,
  placement,
  measuring = false,
  cropMode = false,
  onAreaChange,
  onCropChange,
  onCommit,
  onMeasure,
}: PrintAreaCanvasProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const stageRef = React.useRef<Konva.Stage | null>(null);
  const groupRef = React.useRef<Konva.Group | null>(null);
  const rotateRef = React.useRef<Konva.Circle | null>(null);
  const rotateStemRef = React.useRef<Konva.Line | null>(null);
  const transformerRef = React.useRef<Konva.Transformer | null>(null);
  const measureRef = React.useRef<Konva.Line | null>(null);
  /** True while a gesture is in flight: the props must not fight the pointer. */
  const busyRef = React.useRef(false);
  /** The crop at the start of a drag, and the pointer that started it. */
  const cropDragRef = React.useRef<{
    crop: AreaCrop;
    pointer: { x: number; y: number };
    handle: CropAnchor | null;
  } | null>(null);
  const [containerSize, setContainerSize] = React.useState({ w: 0, h: 0 });
  /** The frame's chrome: the dashed outline and the handles. */
  const [chromeVisible, setChromeVisible] = React.useState(true);
  /** The live readout, so a drag does not re-render the whole panel. */
  const [live, setLive] = React.useState<{
    x: number;
    y: number;
    scale: number;
    rotation: number;
  } | null>(null);

  const mockupImg = useHtmlImage(mockupUrl);
  const designImg = useHtmlImage(designUrl);

  // The latest callbacks, so the Konva handlers stay stable.
  const handlers = React.useRef({ onAreaChange, onCropChange, onCommit, onMeasure });
  React.useEffect(() => {
    handlers.current = { onAreaChange, onCropChange, onCommit, onMeasure };
  });

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const baseScale = React.useMemo(() => {
    if (containerSize.w === 0 || containerSize.h === 0) return 0;
    const padding = 32;
    return Math.min(
      (containerSize.w - padding) / mockupW,
      (containerSize.h - padding) / mockupH,
    );
  }, [containerSize, mockupW, mockupH]);
  const displayScale = Math.max(0.05, baseScale);
  /**
   * The handles are a constant size ON SCREEN.
   *
   * Konva measures in stage units, and the stage is scaled down to fit the
   * panel - so a 12 unit handle would be 4 screen pixels at this zoom, which
   * is impossible to grab. Every handle is therefore divided by the scale.
   */
  const anchorSize = 9 / displayScale;
  /** How far the rotate handle sits above the frame's edge, in screen pixels. */
  const rotateOffset = 30 / displayScale;
  /** The rotate handle's radius, in screen pixels. */
  const rotateRadius = 8 / displayScale;
  /**
   * The rotate handle's GRABBABLE size, in screen pixels.
   *
   * The knob is 16 px across, which is a small target on a trackpad. Konva
   * widens a shape's hit region by `hitStrokeWidth` without changing what is
   * painted, so the knob looks the same and is three times as easy to catch.
   */
  const rotateHitWidth = 30 / displayScale;

  // The frame, in mockup pixels.
  const framePx = React.useMemo(
    () => (area ? frameToPixels(area.frame, area, mockupW, mockupH) : null),
    [area, mockupW, mockupH],
  );

  /** The visible window into the area; the whole area when there is none. */
  const crop = React.useMemo(() => areaCrop(area ?? {}), [area]);

  /** The crop window on the photo, so its outline and handles can be drawn. */
  const cropRectPx = React.useMemo(
    () => (area ? clipFor(area, area.frame, mockupW, mockupH) : null),
    [area, mockupW, mockupH],
  );

  /** The same window in the frame's local space, for the group's clip. */
  const cropRectLocal = React.useMemo(
    () => (framePx ? cropLocalRect({ crop }, framePx) : null),
    [crop, framePx],
  );

  /** The crop's eight handles, in mockup pixels. */
  const cropHandles = React.useMemo(() => {
    if (!framePx) return [];
    return CROP_ANCHORS.map((anchor) => {
      const point = areaPointInMockup(
        framePx,
        crop.x + anchor.u * crop.width,
        crop.y + anchor.v * crop.height,
      );
      return { id: anchor.id, ...point };
    });
  }, [framePx, crop]);

  /**
   * The pointer, in the MOCKUP's pixels.
   *
   * Konva's stage position is in CANVAS pixels: the stage's own scale maps
   * its children (which live in the mockup's space) onto the canvas, but the
   * pointer is reported before that scale. Every node here is in the
   * mockup's space, so the pointer has to be divided by the stage's scale.
   */
  const pointerInMockup = React.useCallback((): { x: number; y: number } | null => {
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return null;
    return { x: pointer.x / displayScale, y: pointer.y / displayScale };
  }, [displayScale]);

  /**
   * Where the rotate handle sits, in the frame's local space.
   *
   * Above the frame's top edge - unless that would put it off the photo, in
   * which case it sits below the bottom edge. A handle you cannot see is a
   * handle you cannot grab.
   */
  const rotateLocalY = React.useCallback((): number => {
    if (!framePx) return 0;
    const group = groupRef.current;
    const above = -framePx.height / 2 - rotateOffset;
    const below = framePx.height / 2 + rotateOffset;
    const off = group ? group.y() + above < 0 : false;
    return off ? below : above;
  }, [framePx, rotateOffset]);

  /**
   * The rotate handle, above the frame's top edge, turned with the frame.
   *
   * Two things keep it grabbable. It lives in the TOP layer (see the scene),
   * so neither the artwork nor the Transformer's invisible overdraw rect can
   * sit over it. And it is clamped onto the photo: a large frame - or one
   * near the top - can put the natural position off the canvas, where the
   * handle is invisible and unclickable.
   */
  const syncRotateHandle = React.useCallback(() => {
    const handle = rotateRef.current;
    const stem = rotateStemRef.current;
    const group = groupRef.current;
    if (!handle || !stem || !group || !framePx) return;
    const rad = (group.rotation() * Math.PI) / 180;
    const localY = rotateLocalY();
    const edgeY = localY < 0 ? -framePx.height / 2 : framePx.height / 2;
    const margin = rotateRadius + 8 / displayScale;
    const x = clamp(group.x() - localY * Math.sin(rad), margin, mockupW - margin);
    const y = clamp(group.y() + localY * Math.cos(rad), margin, mockupH - margin);
    handle.position({ x, y });
    stem.points([
      group.x() - edgeY * Math.sin(rad),
      group.y() + edgeY * Math.cos(rad),
      x,
      y,
    ]);
    // The handle has its own layer, so the frame's layer draw does not cover it.
    handle.getLayer()?.batchDraw();
  }, [framePx, rotateLocalY, rotateRadius, displayScale, mockupW, mockupH]);

  /**
   * Puts the frame's own transform on the group.
   *
   * It is set IMPERATIVELY and never as a prop: react-konva re-applies props
   * on every render, and a prop for the position would fight the drag and
   * snap the frame back where it started.
   */
  const syncFrame = React.useCallback(() => {
    const group = groupRef.current;
    if (!group || !framePx) return;
    group.x(framePx.cx);
    group.y(framePx.cy);
    group.rotation(framePx.rotation);
    group.scaleX(1);
    group.scaleY(1);
    syncRotateHandle();
    group.getLayer()?.batchDraw();
  }, [framePx, syncRotateHandle]);

  // The area changed from outside (a template, a new size): adopt it.
  React.useEffect(() => {
    if (busyRef.current) return;
    syncFrame();
    setLive(
      area
        ? {
            x: area.frame.x,
            y: area.frame.y,
            scale: area.frame.scale,
            rotation: area.frame.rotation,
          }
        : null,
    );
  }, [area, syncFrame]);

  /**
   * Keeps the Transformer attached to the frame.
   *
   * Two things have to be right here, or the frame is left with no handles
   * (or, worse, with handles it should not have):
   *
   * 1. The chrome toggle DETACHES the Transformer. It lives outside the
   *    frame's group, so hiding the dashed outline and the rotate handle
   *    left its border and its four corner anchors painted over the design -
   *    the frame still looked "selected" after a click on the empty photo.
   * 2. The deps include the image and the frame, not just the area. The
   *    first run happens while the mockup image is still loading, when the
   *    component renders "Loading images…" and neither the group nor the
   *    Transformer exists yet - so the refs are null and the transformer was
   *    never attached at all, which is a frame with no way to resize it.
   */
  React.useEffect(() => {
    const transformer = transformerRef.current;
    const group = groupRef.current;
    if (!transformer) return;
    // In crop mode the Transformer comes off entirely: its overdraw overlay
    // would swallow the drags meant for the crop window.
    transformer.nodes(chromeVisible && !cropMode && group ? [group] : []);
    transformer.getLayer()?.batchDraw();
  }, [area, chromeVisible, cropMode, framePx, mockupImg]);

  // Turning the crop on while the chrome is hidden would leave the tool with
  // nothing to grab, so cropping always brings the chrome back.
  React.useEffect(() => {
    if (cropMode) setChromeVisible(true);
  }, [cropMode]);

  /** The frame's transform as it is right now, from the group. */
  const frameFromGroup = React.useCallback(() => {
    const group = groupRef.current;
    if (!group || !area) return null;
    const scale = area.frame.scale * Math.abs(group.scaleX());
    return {
      x: group.x() / mockupW,
      y: group.y() / mockupH,
      scale,
      rotation: group.rotation(),
    };
  }, [area, mockupW, mockupH]);

  const reportLive = React.useCallback(() => {
    const next = frameFromGroup();
    if (next) setLive(next);
  }, [frameFromGroup]);

  // --- the frame's gestures --------------------------------------------------

  const onFrameDragEnd = () => {
    const next = frameFromGroup();
    busyRef.current = false;
    if (next && area) {
      handlers.current.onAreaChange({
        ...area,
        frame: { ...area.frame, x: next.x, y: next.y },
      });
    }
    handlers.current.onCommit?.();
  };

  const onFrameTransform = () => {
    reportLive();
    // The knob lives in its own layer, so it has to be moved by hand while
    // the frame is being resized.
    syncRotateHandle();
  };

  /**
   * The rotate handle: a drag turns the frame around its own centre.
   *
   * Konva's own rotation anchor is fiddly to grab, and the user asked for
   * the turn to come from the same place as the resize, so the handle is
   * drawn here: a knob above the frame's edge that follows the pointer.
   */
  const onRotateDrag = () => {
    const group = groupRef.current;
    const pointer = pointerInMockup();
    if (!group || !pointer || !framePx) return;
    // The handle's resting angle: straight up, or straight down when it had
    // to move below the frame.
    const resting = rotateLocalY() < 0 ? -90 : 90;
    const angle = (Math.atan2(pointer.y - group.y(), pointer.x - group.x()) * 180) / Math.PI;
    group.rotation(angle - resting);
    syncRotateHandle();
    reportLive();
  };

  const onRotateDragEnd = () => {
    const group = groupRef.current;
    if (!group || !area) return;
    busyRef.current = false;
    handlers.current.onAreaChange({
      ...area,
      frame: { ...area.frame, rotation: group.rotation() },
    });
    handlers.current.onCommit?.();
  };

  const onFrameTransformEnd = () => {
    const next = frameFromGroup();
    busyRef.current = false;
    if (next && area) {
      // The Transformer scaled and rotated the GROUP, so the artwork inside
      // came along. The size is baked into the frame and the group is reset,
      // which keeps the drawing identical.
      handlers.current.onAreaChange({
        ...area,
        frame: { ...area.frame, scale: next.scale, rotation: next.rotation },
      });
    }
    handlers.current.onCommit?.();
  };

  // --- the crop window's gestures -------------------------------------------

  /**
   * A crop drag, in the AREA's own fractions.
   *
   * The pointer is converted through the frame's rotation, so cropping works
   * at any angle. The crop is committed live: the design's clip has to follow
   * the window while it is dragged, or the user is cropping blind.
   */
  const cropGestureStart = (handle: CropAnchor | null) => {
    const pointer = pointerInMockup();
    if (!pointer || !area) return;
    cropDragRef.current = { crop: areaCrop(area), pointer, handle };
    busyRef.current = true;
  };

  const cropGestureMove = () => {
    const drag = cropDragRef.current;
    const pointer = pointerInMockup();
    if (!drag || !pointer || !framePx) return;
    const from = areaPointFromMockup(framePx, drag.pointer.x, drag.pointer.y);
    const to = areaPointFromMockup(framePx, pointer.x, pointer.y);
    handlers.current.onCropChange?.(
      applyCropDrag(drag.crop, drag.handle, to.u - from.u, to.v - from.v),
    );
  };

  const cropGestureEnd = () => {
    cropDragRef.current = null;
    busyRef.current = false;
    handlers.current.onCommit?.();
  };

  // --- the reference line ----------------------------------------------------

  const onStagePointerDown = (event: Konva.KonvaEventObject<Event>) => {
    if (!measuring) {
      // In crop mode the chrome must stay: the crop's handles ARE the tool,
      // and a click on the photo next to the window would hide them.
      if (cropMode) return;
      // A click on the empty photo hides the frame's chrome: the artwork
      // stays, because it is the result, and the frame is only the tool.
      // A click on anything else brings the chrome back. The check is here
      // rather than on the artwork, because the Transformer's own overlay
      // covers the artwork and would swallow its click.
      if (event.target === event.target.getStage()) setChromeVisible(false);
      else setChromeVisible(true);
      return;
    }
    const pointer = pointerInMockup();
    if (!pointer) return;
    const line = measureRef.current;
    if (!line) return;
    line.points([pointer.x, pointer.y, pointer.x, pointer.y]);
    line.visible(true);
    busyRef.current = true;
    event.cancelBubble = true;
  };

  const onStagePointerMove = () => {
    if (!measuring) return;
    const line = measureRef.current;
    const pointer = pointerInMockup();
    if (!line || !pointer) return;
    const points = line.points();
    line.points([points[0], points[1], pointer.x, pointer.y]);
  };

  const onStagePointerUp = () => {
    if (!measuring) return;
    const line = measureRef.current;
    if (!line) return;
    const points = line.points();
    line.visible(false);
    const pixels = Math.hypot(points[2] - points[0], points[3] - points[1]);
    busyRef.current = false;
    if (pixels > 4) handlers.current.onMeasure?.(Math.round(pixels));
  };

  // --- rendering -------------------------------------------------------------

  if (!mockupImg) {
    return (
      <div
        ref={containerRef}
        className="grid min-h-[420px] w-full place-items-center rounded-lg border border-border-subtle bg-surface-muted/50"
      >
        <span className="text-[13px] text-ink-muted">Loading images…</span>
      </div>
    );
  }

  // The artwork, in the FRAME's local space: the Studio's placement, and the
  // frame carries it from there.
  const artNode =
    framePx && placement && designImg ? (
      <KonvaImage
        image={designImg}
        x={(placement.x - 0.5) * framePx.width}
        y={(placement.y - 0.5) * framePx.height}
        offsetX={designW / 2}
        offsetY={designH / 2}
        width={designW}
        height={designH}
        scaleX={(placement.scale * framePx.width) / designW}
        scaleY={(placement.scale * framePx.width) / designW}
        rotation={placement.angle}
        listening
      />
    ) : null;

  return (
    <div>
      <div
        ref={containerRef}
        className={cn(
          "relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-border-subtle bg-surface-muted/50",
          measuring ? "cursor-crosshair" : "",
        )}
        style={{ minHeight: 420 }}
      >
        <div
          className="relative"
          style={{
            width: mockupW * displayScale,
            height: mockupH * displayScale,
            boxShadow: "0 4px 20px rgba(37,42,38,0.12)",
            background: "#fff",
          }}
        >
          <Stage
            ref={stageRef}
            width={mockupW}
            height={mockupH}
            scaleX={displayScale}
            scaleY={displayScale}
            style={{ width: "100%", height: "100%" }}
            onMouseDown={onStagePointerDown}
            onTouchStart={onStagePointerDown}
            onMouseMove={onStagePointerMove}
            onTouchMove={onStagePointerMove}
            onMouseUp={onStagePointerUp}
            onTouchEnd={onStagePointerUp}
          >
            <Layer>
              <KonvaImage
                image={mockupImg}
                width={mockupW}
                height={mockupH}
                listening={false}
                perfectDrawEnabled={false}
              />
            </Layer>

            {/* The frame. The artwork inside it is clipped to the crop
                window, and the frame's transform carries the artwork with it. */}
            <Layer>
              {framePx ? (
                <Group
                  ref={groupRef}
                  x={framePx.cx}
                  y={framePx.cy}
                  rotation={framePx.rotation}
                  draggable={!measuring && !cropMode}
                  onDragStart={() => {
                    busyRef.current = true;
                  }}
                  onDragMove={() => {
                    reportLive();
                    // The knob has its own layer, so a frame drag has to move
                    // it by hand or the knob is left behind.
                    syncRotateHandle();
                  }}
                  onDragEnd={onFrameDragEnd}
                  onTransformStart={() => {
                    busyRef.current = true;
                  }}
                  onTransform={onFrameTransform}
                  onTransformEnd={onFrameTransformEnd}
                >
                  {/* The design is clipped to the CROP window, in the frame's
                      local space, so it stops at the fold instead of
                      floating over it. The clip lives on an inner group: on
                      the frame's own group it would also cut the dashed
                      outline, and the user would lose sight of the area the
                      print file really uses. */}
                  <Group
                    clipX={cropRectLocal?.x ?? 0}
                    clipY={cropRectLocal?.y ?? 0}
                    clipWidth={cropRectLocal?.width}
                    clipHeight={cropRectLocal?.height}
                  >
                    {artNode}
                  </Group>
                  <Rect
                    x={-framePx.width / 2}
                    y={-framePx.height / 2}
                    width={framePx.width}
                    height={framePx.height}
                    stroke="#314d3d"
                    strokeWidth={1.5 / displayScale}
                    dash={[6 / displayScale, 4 / displayScale]}
                    cornerRadius={2 / displayScale}
                    visible={chromeVisible}
                    listening={false}
                    perfectDrawEnabled={false}
                  />
                </Group>
              ) : null}

              <Line
                ref={measureRef}
                points={[0, 0, 0, 0]}
                stroke="#e0483c"
                strokeWidth={2 / displayScale}
                visible={false}
                listening={false}
              />
            </Layer>

            {/* The frame's handles: a corner scales it (uniformly), the round
                anchor rotates it. */}
            <Layer>
              <Transformer
                ref={transformerRef}
                rotateEnabled={false}
                keepRatio
                flipEnabled={false}
                enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
                borderStroke="#314d3d"
                borderStrokeWidth={1 / displayScale}
                anchorStroke="#314d3d"
                anchorFill="#ffffff"
                anchorSize={anchorSize}
                anchorCornerRadius={2 / displayScale}
                rotateAnchorOffset={24 / displayScale}
                ignoreStroke
                shouldOverdrawWholeArea
                boundBoxFunc={(oldBox, newBox) => {
                  // The frame can never be smaller than a thumb.
                  if (Math.abs(newBox.width) < 60 || Math.abs(newBox.height) < 60) return oldBox;
                  return newBox;
                }}
              />
            </Layer>

            {/* The crop window and the rotate handle, in their own TOP layer.
                Both were unreachable before: a crop handle at the frame's edge
                sat under the Transformer's corner anchor, and the knob sat
                under the Transformer's invisible overdraw overlay, which
                swallowed every click meant for it. */}
            <Layer>
              {cropRectPx ? (
                <Rect
                  x={cropRectPx.x}
                  y={cropRectPx.y}
                  width={cropRectPx.width}
                  height={cropRectPx.height}
                  offsetX={cropRectPx.width / 2}
                  offsetY={cropRectPx.height / 2}
                  rotation={cropRectPx.rotation}
                  fill={cropMode ? "rgba(49,77,61,0.05)" : "transparent"}
                  stroke="#314d3d"
                  strokeWidth={(cropMode ? 1.5 : 1) / displayScale}
                  dash={cropMode ? undefined : [3 / displayScale, 3 / displayScale]}
                  visible={cropMode || (chromeVisible && !isFullCrop(crop))}
                  listening={cropMode}
                  draggable={cropMode}
                  onDragStart={() => cropGestureStart(null)}
                  onDragMove={cropGestureMove}
                  onDragEnd={cropGestureEnd}
                />
              ) : null}

              {cropMode && framePx
                ? cropHandles.map((handle) => (
                    <Rect
                      key={handle.id}
                      x={handle.x}
                      y={handle.y}
                      width={anchorSize}
                      height={anchorSize}
                      offsetX={anchorSize / 2}
                      offsetY={anchorSize / 2}
                      fill="#ffffff"
                      stroke="#314d3d"
                      strokeWidth={1.5 / displayScale}
                      cornerRadius={2 / displayScale}
                      draggable
                      onDragStart={() => cropGestureStart(handle.id)}
                      onDragMove={cropGestureMove}
                      onDragEnd={cropGestureEnd}
                    />
                  ))
                : null}

              <Line
                ref={rotateStemRef}
                points={[0, 0, 0, 0]}
                stroke="#314d3d"
                strokeWidth={1.5 / displayScale}
                visible={chromeVisible && !cropMode}
                listening={false}
              />
              <Circle
                ref={rotateRef}
                radius={rotateRadius}
                fill="#ffffff"
                stroke="#314d3d"
                strokeWidth={2 / displayScale}
                // A wider hit area than the painted dot: 16 px is a small
                // target, and Konva widens the hit region without changing it.
                hitStrokeWidth={rotateHitWidth}
                visible={chromeVisible && !cropMode}
                draggable={!measuring}
                onDragStart={() => {
                  busyRef.current = true;
                }}
                onDragMove={onRotateDrag}
                onDragEnd={onRotateDragEnd}
              />
            </Layer>
          </Stage>
        </div>
      </div>

      {/* The live readout. It lives here, so a drag only re-renders the
          canvas and not the whole panel. */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-subtle">
        {live && placement ? (
          <>
            <span>
              Frame <b className="text-ink">{Math.round(live.scale * 100)}%</b> of the photo
              {live.rotation ? ` · ${Math.round(live.rotation)}°` : ""}
            </span>
            <span>
              Design <b className="text-ink">{Math.round(placement.scale * 100)}%</b> of the print
              area width
            </span>
            <span>
              Placement x {placement.x.toFixed(2)} · y {placement.y.toFixed(2)} ·{" "}
              {Math.round(placement.angle)}°
            </span>
            <span>
              {cropMode
                ? "Drag the window to move it, its handles to crop. The design is cut at the window."
                : isFullCrop(crop)
                  ? "Drag the frame to move it, its corner to resize, the round handle to rotate."
                  : `Window: ${describeCrop(crop)}. Turn on Crop to change it.`}
            </span>
          </>
        ) : (
          <span>Pick a design and set a print area to place it.</span>
        )}
      </div>
    </div>
  );
}

export default PrintAreaCanvas;
