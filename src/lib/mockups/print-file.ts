// ---------------------------------------------------------------------------
// The print file: what Printify would actually print.
//
// This is the artwork rendered at the print area's real pixel size (e.g.
// 4500 x 5400), placed with the Printify Studio's own numbers and cropped to
// the area's bounds - the part of the design that falls outside the printable
// area is cut off, exactly as it would be on the product.
//
// It is drawn at the AREA's resolution, not the mockup's: the mockup photo is
// only a preview of where the print sits, the file is the print.
// ---------------------------------------------------------------------------

import { canvasToBlob, decodeImage } from "@/lib/image/image";
import type { MockupPrintArea, StudioPlacement } from "@/types/domain";

export interface PrintFileInput {
  /** The artwork to print. */
  designBlob: Blob;
  /** The print area it is printed into. */
  area: MockupPrintArea;
  /** The Studio placement: scale, x, y, angle. */
  placement: StudioPlacement;
}

export interface PrintFileResult {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Renders the print file.
 *
 * The placement's `scale` is the artwork's width as a fraction of the area's
 * width (Printify's convention), and `x`/`y` are the CENTRE of the artwork
 * inside the area.
 */
export async function renderPrintFile(input: PrintFileInput): Promise<PrintFileResult> {
  const { area, placement } = input;
  const width = Math.max(1, Math.round(area.areaWidth));
  const height = Math.max(1, Math.round(area.areaHeight));

  const bitmap = await decodeImage(input.designBlob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create the print canvas");
    ctx.imageSmoothingQuality = "high";

    const designWidthPx = Math.max(1, placement.scale) * width;
    const designHeightPx = designWidthPx * (bitmap.height / bitmap.width);

    ctx.save();
    ctx.translate(placement.x * width, placement.y * height);
    if (placement.angle % 360 !== 0) ctx.rotate((placement.angle * Math.PI) / 180);
    ctx.drawImage(bitmap, -designWidthPx / 2, -designHeightPx / 2, designWidthPx, designHeightPx);
    ctx.restore();

    const blob = await canvasToBlob(canvas, "image/png");
    canvas.width = 0;
    canvas.height = 0;
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}

/**
 * The largest print file we will render.
 *
 * 4500 x 5400 is 24 megapixels - about 97 MB of RGBA in the browser. That is
 * what Printify expects, but a canvas that size is close to the limit of
 * what a tab can hold, so anything bigger is refused with a clear reason
 * rather than a silent failure.
 */
export const MAX_PRINT_FILE_PIXELS = 30_000_000;

/** True when a print file of this size is safe to render. */
export function canRenderPrintFile(area: MockupPrintArea): boolean {
  return area.areaWidth * area.areaHeight <= MAX_PRINT_FILE_PIXELS;
}
