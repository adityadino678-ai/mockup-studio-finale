"use client";

// ---------------------------------------------------------------------------
// Artwork → base64 for Printify uploads.
//
// Printify uploads are base64 JSON, which inflates size by ~33%. The Worker
// rejects bodies over 8 MB, so large artwork is downscaled through a canvas
// first. PNG is preserved so transparency survives.
// ---------------------------------------------------------------------------

export const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode the artwork image"));
    };
    img.src = url;
  });
}

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read the artwork"));
    reader.readAsDataURL(blob);
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the artwork"))),
      "image/png",
    );
  });
}

/** Base64 byte estimate that matches the server's own size check. */
export function estimateBase64Bytes(base64: string): number {
  const clean = base64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "").replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}

/**
 * Returns the artwork as base64, downscaling it through a canvas until it fits
 * the upload cap. Throws when even the smallest attempt is too large.
 */
export async function artworkToBase64(blob: Blob, maxBytes = MAX_ARTWORK_BYTES): Promise<string> {
  let base64 = await readBase64(blob);
  if (estimateBase64Bytes(base64) <= maxBytes) return base64;

  const img = await loadImage(blob);
  for (const cap of [2000, 1400, 1000, 700]) {
    const scale = Math.min(1, cap / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    base64 = await readBase64(await canvasToPng(canvas));
    if (estimateBase64Bytes(base64) <= maxBytes) return base64;
  }
  throw new Error("Artwork is too large to upload even after downscaling. Try a smaller PNG.");
}

/**
 * Returns the artwork as base64, resampled to fit the print area.
 *
 * Printify validates the uploaded image's resolution against the print area
 * and rejects artwork that is too low ("Image has low quality"), so the file
 * is sized to the area rather than sent at whatever resolution it happened
 * to be. That also keeps the upload small - a 6000 px PNG becomes a ~1 MB one.
 *
 * The artwork is never UPSCALED: extra pixels carry no detail, so they would
 * only make the upload bigger. A design smaller than the print area therefore
 * stays small, and the caller is told so it can warn the user.
 *
 * When the file is still too big the size is stepped down in stages, with a
 * floor of 1200 px. An earlier version fell back to a 700 px image here,
 * which Printify rejects outright.
 */
export async function artworkToBase64Sized(
  blob: Blob,
  targetLongEdge: number,
  maxBytes = MAX_ARTWORK_BYTES,
): Promise<string> {
  const img = await loadImage(blob);
  const longest = Math.max(img.width, img.height);

  const render = async (longEdge: number): Promise<string> => {
    const scale = Math.min(1, longEdge / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D context");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return readBase64(await canvasToPng(canvas));
  };

  const ceiling = Math.min(longest, targetLongEdge);
  const candidates = [ceiling, ceiling * 0.8, ceiling * 0.6]
    .concat([2400, 1800, 1200].filter((v) => v < ceiling))
    .filter((v) => v > 0)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => b - a);

  for (const edge of candidates) {
    const base64 = await render(edge);
    if (estimateBase64Bytes(base64) <= maxBytes) return base64;
  }
  throw new Error(
    "Artwork is too large to upload at the print area size. Use a smaller or flatter file.",
  );
}
