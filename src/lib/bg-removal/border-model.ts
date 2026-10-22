// ---------------------------------------------------------------------------
// Background removal by modelling the background from the image border.
//
// This is a DIFFERENT method from the flood key, and it is the one that works
// on the photographs the flood key cannot touch.
//
// The flood key needs one exact colour to match to within a tolerance, so it
// removes a ragged patch of the background and leaves the rest. But the
// background of a studio shot is rarely one exact colour: it is a white
// sweep that falls off towards the edges, a grey backdrop with a vignette, a
// coloured card lit from one side. The flood key matches the middle of that
// gradient and leaves a halo.
//
// This engine estimates the background from the BORDER of the image - the
// ring of pixels that is background by definition - and takes the estimate
// ALONG each row and column, so a gradient that falls off towards the edges
// is followed rather than matched against a single colour.
//
//   For a pixel at (x, y) the background candidates are:
//     - the column's top and bottom border pixels (so a vertical gradient is
//       followed), and
//     - the row's left and right border pixels (so a horizontal gradient is
//       followed).
//
// A pixel is background when it is within the tolerance of ANY of those.
// The removal is then restricted to the pixels CONNECTED to the border, which
// is what keeps a white shape inside the artwork from being erased.
//
// It is instant, deterministic, needs no network and no model, so it is the
// engine that still works when the AI model cannot be downloaded.
// ---------------------------------------------------------------------------

export interface BorderModelOptions {
  /** Colour distance (0..255 euclidean RGB) considered "background". */
  tolerance: number;
  /** Extra ramp above the tolerance for soft edges (alpha feathering). */
  softness?: number;
}

export const BORDER_MODEL_DEFAULTS: BorderModelOptions = { tolerance: 40, softness: 28 };

function colorDist(
  r: number,
  g: number,
  b: number,
  sr: number,
  sg: number,
  sb: number,
): number {
  const dr = r - sr;
  const dg = g - sg;
  const db = b - sb;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * The median of five values.
 *
 * Wider than a 3-tap median on purpose: the border estimates are taken from
 * the image edge, and a subject that runs off the edge would otherwise
 * poison the estimate for its whole column. Five samples means one
 * contaminated column cannot move the estimate.
 */
function median5(a: number, b: number, c: number, d: number, e: number): number {
  const sorted = [a, b, c, d, e].sort((x, y) => x - y);
  return sorted[2];
}

/**
 * Removes the background from RGBA pixel data, in place.
 *
 * Returns how many pixels changed. The alpha of a kept pixel is never
 * lowered; a removed pixel gets alpha 0, and the pixels just outside the
 * tolerance get a partial alpha so the edge is not a hard jaggy.
 */
export function borderModelRemoveBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: BorderModelOptions = BORDER_MODEL_DEFAULTS,
): { removedPixels: number } {
  const tolerance = Math.max(0, options.tolerance);
  const softness = Math.max(0, options.softness ?? BORDER_MODEL_DEFAULTS.softness ?? 28);
  if (width < 3 || height < 3) return { removedPixels: 0 };

  const at = (x: number, y: number) => (y * width + x) * 4;

  // The border estimates. Each column has a top and a bottom estimate; each
  // row has a left and a right one. The 3-tap median smooths the noise a
  // JPEG edge always carries.
  const colTop = new Uint8Array(width);
  const colTopG = new Uint8Array(width);
  const colTopB = new Uint8Array(width);
  const colBot = new Uint8Array(width);
  const colBotG = new Uint8Array(width);
  const colBotB = new Uint8Array(width);
  const rowLeft = new Uint8Array(height);
  const rowLeftG = new Uint8Array(height);
  const rowLeftB = new Uint8Array(height);
  const rowRight = new Uint8Array(height);
  const rowRightG = new Uint8Array(height);
  const rowRightB = new Uint8Array(height);

  for (let x = 0; x < width; x++) {
    const xa = Math.max(0, x - 2);
    const xb = Math.max(0, x - 1);
    const xc = x;
    const xd = Math.min(width - 1, x + 1);
    const xe = Math.min(width - 1, x + 2);
    const top = at(xc, 0);
    const top2 = at(xb, 0);
    const top3 = at(xa, 0);
    const top4 = at(xd, 0);
    const top5 = at(xe, 0);
    colTop[x] = median5(pixels[top3], pixels[top2], pixels[top], pixels[top4], pixels[top5]);
    colTopG[x] = median5(pixels[top3 + 1], pixels[top2 + 1], pixels[top + 1], pixels[top4 + 1], pixels[top5 + 1]);
    colTopB[x] = median5(pixels[top3 + 2], pixels[top2 + 2], pixels[top + 2], pixels[top4 + 2], pixels[top5 + 2]);
    const bot = at(xc, height - 1);
    const bot2 = at(xb, height - 1);
    const bot3 = at(xa, height - 1);
    const bot4 = at(xd, height - 1);
    const bot5 = at(xe, height - 1);
    colBot[x] = median5(pixels[bot3], pixels[bot2], pixels[bot], pixels[bot4], pixels[bot5]);
    colBotG[x] = median5(pixels[bot3 + 1], pixels[bot2 + 1], pixels[bot + 1], pixels[bot4 + 1], pixels[bot5 + 1]);
    colBotB[x] = median5(pixels[bot3 + 2], pixels[bot2 + 2], pixels[bot + 2], pixels[bot4 + 2], pixels[bot5 + 2]);
  }
  for (let y = 0; y < height; y++) {
    const ya = Math.max(0, y - 2);
    const yb = Math.max(0, y - 1);
    const yc = y;
    const yd = Math.min(height - 1, y + 1);
    const ye = Math.min(height - 1, y + 2);
    const left = at(0, yc);
    const left2 = at(0, yb);
    const left3 = at(0, ya);
    const left4 = at(0, yd);
    const left5 = at(0, ye);
    rowLeft[y] = median5(pixels[left3], pixels[left2], pixels[left], pixels[left4], pixels[left5]);
    rowLeftG[y] = median5(pixels[left3 + 1], pixels[left2 + 1], pixels[left + 1], pixels[left4 + 1], pixels[left5 + 1]);
    rowLeftB[y] = median5(pixels[left3 + 2], pixels[left2 + 2], pixels[left + 2], pixels[left4 + 2], pixels[left5 + 2]);
    const right = at(width - 1, yc);
    const right2 = at(width - 1, yb);
    const right3 = at(width - 1, ya);
    const right4 = at(width - 1, yd);
    const right5 = at(width - 1, ye);
    rowRight[y] = median5(pixels[right3], pixels[right2], pixels[right], pixels[right4], pixels[right5]);
    rowRightG[y] = median5(pixels[right3 + 1], pixels[right2 + 1], pixels[right + 1], pixels[right4 + 1], pixels[right5 + 1]);
    rowRightB[y] = median5(pixels[right3 + 2], pixels[right2 + 2], pixels[right + 2], pixels[right4 + 2], pixels[right5 + 2]);
  }

  // How far each pixel is from its background estimates: the best (smallest)
  // distance decides.
  const distance = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = at(x, y);
      const r = pixels[p];
      const g = pixels[p + 1];
      const b = pixels[p + 2];
      const d = Math.min(
        colorDist(r, g, b, colTop[x], colTopG[x], colTopB[x]),
        colorDist(r, g, b, colBot[x], colBotG[x], colBotB[x]),
        colorDist(r, g, b, rowLeft[y], rowLeftG[y], rowLeftB[y]),
        colorDist(r, g, b, rowRight[y], rowRightG[y], rowRightB[y]),
      );
      distance[y * width + x] = d;
    }
  }

  // Only the background CONNECTED to the border is removed. A white shape in
  // the middle of the artwork is not connected to the border, so it stays.
  const connected = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const push = (idx: number) => {
    if (connected[idx]) return;
    connected[idx] = 1;
    queue[tail++] = idx;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  const hardLimit = tolerance;
  const softLimit = tolerance + softness;

  while (head < tail) {
    const idx = queue[head++];
    if (distance[idx] > softLimit) continue;
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }

  // The alpha each pixel ends up with.
  //
  // A CONNECTED pixel in the soft band gets the ramp, exactly like the flood
  // key does: without it the cutout has a hard jaggy edge where the
  // background fades. A pixel that is NOT connected is only softened when it
  // sits next to a pixel that was actually affected - that is what keeps a
  // white shape inside the artwork from being eaten by the ramp.
  const newAlpha = new Float32Array(width * height);
  for (let idx = 0; idx < width * height; idx++) newAlpha[idx] = pixels[idx * 4 + 3];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!connected[idx]) continue;
      const d = distance[idx];
      if (d > softLimit) continue;
      const ramp =
        d <= hardLimit
          ? 0
          : 255 * (1 - (d - hardLimit) / Math.max(1, softLimit - hardLimit));
      if (ramp < newAlpha[idx]) newAlpha[idx] = ramp;
    }
  }

  // The soft edge just inside the subject.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (connected[idx]) continue;
      const d = distance[idx];
      if (d > softLimit) continue;
      let neighbour = 255;
      if (x > 0) neighbour = Math.min(neighbour, newAlpha[idx - 1]);
      if (x < width - 1) neighbour = Math.min(neighbour, newAlpha[idx + 1]);
      if (y > 0) neighbour = Math.min(neighbour, newAlpha[idx - width]);
      if (y < height - 1) neighbour = Math.min(neighbour, newAlpha[idx + width]);
      // Only next to a pixel that was affected: an interior detail is not.
      if (neighbour >= 255) continue;
      const ramp = 255 * (1 - (d - hardLimit) / Math.max(1, softLimit - hardLimit));
      if (ramp < newAlpha[idx]) newAlpha[idx] = ramp;
    }
  }

  let removedPixels = 0;
  for (let idx = 0; idx < width * height; idx++) {
    const p = idx * 4;
    if (newAlpha[idx] < pixels[p + 3]) {
      pixels[p + 3] = newAlpha[idx];
      removedPixels++;
    }
  }

  return { removedPixels };
}
