import type { Transform } from "@/types/domain";

/** A rectangle in canvas pixels. */
export interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Transform math. This module is the single source of truth for how a
// placement is rendered. The Konva editor, the batch worker, and the export
// compositor all call drawPlacement / computeDrawRect, which guarantees that
// exported output matches the on-screen editor exactly.
// ---------------------------------------------------------------------------

export interface PlacementGeometry {
  /** Center of the design in canvas pixels. */
  cx: number;
  cy: number;
  /** Drawn design width/height in canvas pixels (before flip). */
  drawW: number;
  drawH: number;
  designW: number;
  designH: number;
}

export function computeGeometry(
  mockupW: number,
  mockupH: number,
  designW: number,
  designH: number,
  t: Transform,
): PlacementGeometry {
  if (designW <= 0 || designH <= 0) {
    throw new Error("Design has invalid dimensions");
  }
  const drawW = mockupW * t.scale;
  const drawH = drawW * (designH / designW) * (t.stretch ?? 1);
  return {
    cx: mockupW * t.x,
    cy: mockupH * t.y,
    drawW,
    drawH,
    designW,
    designH,
  };
}

/**
 * Draws a design onto a 2D context with the given transform.
 * Works with both HTMLCanvasElement and OffscreenCanvas contexts.
 */
export function drawPlacement(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  design: CanvasImageSource | ImageBitmap,
  geo: PlacementGeometry,
  t: Transform,
  clip?: ClipRect,
): void {
  const { cx, cy, drawW, drawH } = geo;
  if (drawW <= 0 || drawH <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, t.opacity));
  // The clip is applied in CANVAS space, before the design's own transform, so
  // the cut follows the print area on the mockup and not the artwork's angle.
  if (clip) {
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.width, clip.height);
    ctx.clip();
  }
  ctx.translate(cx, cy);
  if (t.rotation % 360 !== 0) {
    ctx.rotate((t.rotation * Math.PI) / 180);
  }
  const fx = t.flipX ? -1 : 1;
  const fy = t.flipY ? -1 : 1;
  if (fx !== 1 || fy !== 1) ctx.scale(fx, fy);
  ctx.drawImage(design as Parameters<OffscreenCanvasRenderingContext2D["drawImage"]>[0], -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
}

/** Structural type satisfied by both HTMLCanvasElement and OffscreenCanvas. */
export interface Canvas2DSource {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

export function composeToCanvas(
  canvas: Canvas2DSource,
  mockupBmp: ImageBitmap,
  designBmp: ImageBitmap,
  t: Transform,
  opts: { drawDesignFirst?: boolean; clip?: ClipRect } = {},
): Canvas2DSource | null {
  const w = mockupBmp.width;
  const h = mockupBmp.height;
  if (w <= 0 || h <= 0) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  const geo = computeGeometry(w, h, designBmp.width, designBmp.height, t);
  if (opts.drawDesignFirst) {
    drawPlacement(ctx, designBmp, geo, t, opts.clip);
    ctx.drawImage(mockupBmp, 0, 0, w, h);
  } else {
    ctx.drawImage(mockupBmp, 0, 0, w, h);
    drawPlacement(ctx, designBmp, geo, t, opts.clip);
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Ink variants: alpha-preserving recolor. NOT an inversion — colored pixels
// are mapped to a flat ink color while alpha and anti-aliasing are kept.
// Results are always presented for review and can be replaced by a manual
// upload.
// ---------------------------------------------------------------------------

export function recolorToInk(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bmp: ImageBitmap,
  ink: "white" | "black",
): void {
  const w = bmp.width;
  const h = bmp.height;
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  if (!tctx) throw new Error("Could not get 2D context");
  tctx.drawImage(bmp, 0, 0);
  const data = tctx.getImageData(0, 0, w, h);
  const px = data.data;
  const v = ink === "white" ? 255 : 0;
  // Slightly lift pure black for white ink (pure white on white paper mock)
  // and vice versa is fine — flat color keeps gradients from being faked.
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    // keep alpha
  }
  tctx.putImageData(data, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}

export async function createInkVariantBlob(
  bmp: ImageBitmap,
  ink: "white" | "black",
  toBlob: (canvas: HTMLCanvasElement) => Promise<Blob>,
): Promise<{ blob: Blob; width: number; height: number }> {
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get 2D context");
  recolorToInk(ctx, bmp, ink);
  const blob = await toBlob(canvas);
  return { blob, width: bmp.width, height: bmp.height };
}
