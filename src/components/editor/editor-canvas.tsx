"use client";

import * as React from "react";
import { Stage, Layer, Image as KonvaImage, Transformer } from "react-konva";
import type Konva from "konva";
import type { Transform } from "@/types/domain";

interface EditorCanvasProps {
  mockupUrl: string;
  mockupW: number;
  mockupH: number;
  designUrl: string;
  designW: number;
  designH: number;
  transform: Transform;
  behindMockup: boolean;
  lockAspect: boolean;
  selected: boolean;
  zoom: number;
  /** Live transform updates while dragging (no history). */
  onTransformChange: (t: Transform) => void;
  /** Fired when a discrete interaction ends — push history. */
  onCommit: () => void;
  onSelect: (selected: boolean) => void;
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

export function EditorCanvas({
  mockupUrl,
  mockupW,
  mockupH,
  designUrl,
  designW,
  designH,
  transform,
  behindMockup,
  lockAspect,
  selected,
  zoom,
  onTransformChange,
  onCommit,
  onSelect,
}: EditorCanvasProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const designNodeRef = React.useRef<Konva.Image>(null);
  const transformerRef = React.useRef<Konva.Transformer>(null);
  const [containerSize, setContainerSize] = React.useState({ w: 0, h: 0 });

  const mockupImg = useHtmlImage(mockupUrl);
  const designImg = useHtmlImage(designUrl);

  // Track the latest callbacks so Konva event handlers stay stable.
  const onTransformChangeRef = React.useRef(onTransformChange);
  const onCommitRef = React.useRef(onCommit);
  React.useEffect(() => {
    onTransformChangeRef.current = onTransformChange;
    onCommitRef.current = onCommit;
  });

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setContainerSize({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit scale: show the whole mockup, then apply user zoom.
  const baseScale = React.useMemo(() => {
    if (containerSize.w === 0 || containerSize.h === 0) return 0;
    const padding = 32;
    return Math.min(
      (containerSize.w - padding) / mockupW,
      (containerSize.h - padding) / mockupH,
    );
  }, [containerSize, mockupW, mockupH]);
  const displayScale = Math.max(0.05, baseScale * zoom);

  const emitFromNode = React.useCallback(() => {
    const node = designNodeRef.current;
    if (!node) return;
    const absScaleX = Math.abs(node.scaleX());
    const absScaleY = Math.abs(node.scaleY());
    const next: Transform = {
      x: node.x() / mockupW,
      y: node.y() / mockupH,
      scale: (absScaleX * designW) / mockupW,
      rotation: node.rotation(),
      flipX: node.scaleX() < 0,
      flipY: node.scaleY() < 0,
      opacity: node.opacity(),
      stretch: absScaleX > 0 ? absScaleY / absScaleX : 1,
    };
    onTransformChangeRef.current(next);
  }, [mockupW, mockupH, designW]);

  // Attach transformer to the design node when selected.
  React.useEffect(() => {
    const transformer = transformerRef.current;
    const node = designNodeRef.current;
    if (!transformer) return;
    transformer.nodes(selected && node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [designImg, selected]);

  React.useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    transformer.enabledAnchors(
      lockAspect
        ? ["top-left", "top-right", "bottom-left", "bottom-right"]
        : ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"],
    );
    transformer.keepRatio(lockAspect);
  }, [lockAspect]);

  if (!mockupImg || !designImg) {
    return (
      <div
        ref={containerRef}
        className="flex h-full w-full items-center justify-center rounded-lg border border-border-subtle bg-surface-muted/50"
      >
        <span className="text-[13px] text-ink-muted">Loading images…</span>
      </div>
    );
  }

  const s = (transform.scale * mockupW) / designW;
  const designNode = (
    <KonvaImage
      ref={designNodeRef}
      image={designImg}
      x={transform.x * mockupW}
      y={transform.y * mockupH}
      offsetX={designW / 2}
      offsetY={designH / 2}
      width={designW}
      height={designH}
      scaleX={s * (transform.flipX ? -1 : 1)}
      scaleY={s * transform.stretch * (transform.flipY ? -1 : 1)}
      rotation={transform.rotation}
      opacity={transform.opacity}
      draggable
      listening
      onMouseDown={() => onSelect(true)}
      onTap={() => onSelect(true)}
      onDragMove={emitFromNode}
      onDragEnd={() => {
        emitFromNode();
        onCommitRef.current();
      }}
      onTransform={emitFromNode}
      onTransformEnd={() => {
        emitFromNode();
        onCommitRef.current();
      }}
    />
  );

  const mockupNode = (
    <KonvaImage
      image={mockupImg}
      width={mockupW}
      height={mockupH}
      listening={false}
      perfectDrawEnabled={false}
    />
  );

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg border border-border-subtle bg-surface-muted/50"
      onMouseDown={(e) => {
        // Click on empty canvas deselects.
        if (e.target === e.currentTarget) onSelect(false);
      }}
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
          width={mockupW}
          height={mockupH}
          scaleX={displayScale}
          scaleY={displayScale}
          style={{ width: "100%", height: "100%" }}
          onMouseDown={(e) => {
            if (e.target === e.target.getStage()) onSelect(false);
          }}
          onTouchStart={(e) => {
            if (e.target === e.target.getStage()) onSelect(false);
          }}
        >
          <Layer>
            {behindMockup ? designNode : mockupNode}
            {behindMockup ? mockupNode : designNode}
            <Transformer
              ref={transformerRef}
              rotateEnabled
              keepRatio={lockAspect}
              flipEnabled={false}
              borderStroke="#314d3d"
              borderStrokeWidth={1}
              anchorStroke="#314d3d"
              anchorFill="#ffffff"
              anchorSize={7}
              anchorCornerRadius={2}
              rotateAnchorOffset={22}
            />
          </Layer>
        </Stage>
      </div>
    </div>
  );
}

export default EditorCanvas;
