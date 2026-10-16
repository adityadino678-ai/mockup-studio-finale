// ---------------------------------------------------------------------------
// Image helpers: decode, thumbnails, validation, compositing.
// Shared by editor preview, batch worker, and export — the same transform
// math always produces the rendered output.
// ---------------------------------------------------------------------------

export const MAX_FILE_BYTES = 40 * 1024 * 1024; // 40 MB

export const ACCEPTED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "file";
}

export function validateImageFile(file: File): { ok: true } | { ok: false; error: string } {
  if (!ACCEPTED_MIMES.has(file.type)) {
    return { ok: false, error: `Unsupported file type "${file.type || "unknown"}". Use PNG, JPEG or WebP.` };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB, limit 40 MB).` };
  }
  if (file.size === 0) {
    return { ok: false, error: `"${file.name}" is empty.` };
  }
  return { ok: true };
}

export interface DecodedImage {
  width: number;
  height: number;
}

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch {
    // Fall back to an <img> decode for formats/browsers with bitmap issues.
    return await decodeViaImg(blob);
  }
}

function decodeViaImg(blob: Blob): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Could not get 2D context"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      createImageBitmap(canvas).then(resolve, reject);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image"));
    };
    img.src = url;
  });
}

export async function getImageInfo(blob: Blob): Promise<DecodedImage & { hasAlpha: boolean }> {
  const bmp = await decodeImage(blob);
  let hasAlpha = true;
  // Cheap alpha check: sample the bitmap for any non-opaque pixel.
  try {
    const { width, height } = bmp;
    const sampleCanvas = document.createElement("canvas");
    const sw = Math.min(width, 128);
    const sh = Math.min(height, 128);
    sampleCanvas.width = sw;
    sampleCanvas.height = sh;
    const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(bmp, 0, 0, sw, sh);
      const data = ctx.getImageData(0, 0, sw, sh).data;
      hasAlpha = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) {
          hasAlpha = true;
          break;
        }
      }
    }
  } catch {
    // If sampling fails, assume alpha may exist.
  }
  const info = { width: bmp.width, height: bmp.height, hasAlpha };
  bmp.close();
  return info;
}

export async function makeThumbnail(blob: Blob, maxSize = 400): Promise<Blob> {
  const bmp = await decodeImage(blob);
  const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const thumb = await canvasToBlob(canvas, "image/webp", 0.82);
  return thumb;
}

export function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))),
      mime,
      quality,
    );
  });
}

export async function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Loads an object URL for an asset; returns the url and a revoke handle. */
export function objectUrlFor(blob: Blob): { url: string; revoke: () => void } {
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}
