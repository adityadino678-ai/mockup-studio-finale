"use client";

// ---------------------------------------------------------------------------
// Listing image -> a small JPEG for Printify's mockup upload.
//
// Printify's web session endpoint wants a URL, so the app uploads the listing
// render to the API first. A full-size PNG mockup is several megabytes; JPEG
// at a listing-friendly size keeps a batch of ten images inside the Worker's
// request and memory budgets without visible quality loss.
// ---------------------------------------------------------------------------

/** Keep every image comfortably below the route's per-image limit. */
export const MAX_MOCKUP_UPLOAD_BYTES = 2 * 1024 * 1024;

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode the listing image"));
    };
    image.src = url;
  });
}

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read the listing image"));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the listing image"))),
      "image/jpeg",
      quality,
    );
  });
}

function safeStem(name: string): string {
  const stem = name
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem || "mockup";
}

/**
 * Converts a render to a JPEG under `MAX_MOCKUP_UPLOAD_BYTES`.
 *
 * Transparency is flattened onto white: a listing image is a product photo,
 * and a JPEG cannot carry alpha. The longest edge starts at 2000px and steps
 * down only when the encoded file is still too large.
 */
export async function mockupImageForUpload(
  blob: Blob,
  name: string,
): Promise<{ base64: string; filename: string }> {
  const image = await loadImage(blob);
  if (!image.naturalWidth || !image.naturalHeight) {
    image.src = "";
    throw new Error("The listing image has no dimensions");
  }
  try {
    for (const maxEdge of [2000, 1600, 1200, 900, 640]) {
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not prepare the listing image");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, width, height);

      for (const quality of [0.9, 0.82, 0.72]) {
        const jpeg = await canvasToBlob(canvas, quality);
        if (jpeg.size <= MAX_MOCKUP_UPLOAD_BYTES) {
          const base64 = await readBase64(jpeg);
          canvas.width = 0;
          canvas.height = 0;
          return { base64, filename: `${safeStem(name)}.jpg` };
        }
      }
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    image.src = "";
  }
  throw new Error("The listing image is still too large after downscaling");
}
