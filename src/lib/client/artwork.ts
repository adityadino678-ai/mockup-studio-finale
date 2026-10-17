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
