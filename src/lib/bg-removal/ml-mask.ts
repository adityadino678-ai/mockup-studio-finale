// Pure mask helpers for the ML background-removal path.
// No DOM, no onnxruntime: these run in unit tests as well as in the Worker.

/** Intersection-over-union for two binary masks (1 = foreground). */
export function maskIoU(
  predicted: Uint8Array | Float32Array,
  reference: Uint8Array | Float32Array,
): number {
  const n = Math.min(predicted.length, reference.length);
  if (n === 0) return 0;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < n; i++) {
    const p = predicted[i] > 0.5 ? 1 : 0;
    const r = reference[i] > 0.5 ? 1 : 0;
    if (p && r) inter++;
    if (p || r) union++;
  }
  return union === 0 ? 1 : inter / union;
}

function binarize(mask: Float32Array, thresh = 0.5): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] >= thresh ? 1 : 0;
  return out;
}

function connectedComponents(binary: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: Int32Array } {
  const labels = new Int32Array(binary.length).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    if (binary[i] !== 1 || labels[i] !== -1) continue;
    const label = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    labels[i] = label;
    let size = 0;
    while (head < tail) {
      const cur = queue[head++];
      size++;
      const x = cur % w;
      const y = Math.floor(cur / w);
      const neighbours = [x > 0 ? cur - 1 : -1, x < w - 1 ? cur + 1 : -1, y > 0 ? cur - w : -1, y < h - 1 ? cur + w : -1];
      for (const nb of neighbours) {
        if (nb >= 0 && binary[nb] === 1 && labels[nb] === -1) {
          labels[nb] = label;
          queue[tail++] = nb;
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes: Int32Array.from(sizes) };
}

/** Remove foreground islands smaller than `minSize` (set to background). */
export function removeTinyIslands(mask: Float32Array, w: number, h: number, minSize = 16): Float32Array {
  const binary = binarize(mask);
  const { labels, sizes } = connectedComponents(binary, w, h);
  const out = new Float32Array(mask);
  for (let i = 0; i < binary.length; i++) {
    const l = labels[i];
    if (binary[i] === 1 && l >= 0 && sizes[l] < minSize) out[i] = 0;
  }
  return out;
}

/** Fill background holes smaller than `maxSize` (set to foreground). Border-connected holes are kept. */
export function fillSmallHoles(mask: Float32Array, w: number, h: number, maxSize = 256): Float32Array {
  const binary = binarize(mask);
  const bgBinary = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bgBinary[i] = binary[i] === 1 ? 0 : 1;
  const { labels, sizes } = connectedComponents(bgBinary, w, h);
  const borderLabels = new Set<number>();
  for (let x = 0; x < w; x++) {
    borderLabels.add(labels[x] ?? -1);
    borderLabels.add(labels[(h - 1) * w + x] ?? -1);
  }
  for (let y = 0; y < h; y++) {
    borderLabels.add(labels[y * w] ?? -1);
    borderLabels.add(labels[y * w + w - 1] ?? -1);
  }
  const out = new Float32Array(mask);
  for (let i = 0; i < binary.length; i++) {
    const l = labels[i];
    if (bgBinary[i] === 1 && l >= 0 && !borderLabels.has(l) && sizes[l] <= maxSize) out[i] = 1;
  }
  return out;
}

/** Bilinear upscale of a soft mask from (sw,sh) to (dw,dh). */
export function upscaleMaskBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const dst = new Float32Array(dw * dh);
  if (sw === 0 || sh === 0 || dw === 0 || dh === 0) return dst;
  const xScale = sw / dw;
  const yScale = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, y * yScale));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, x * xScale));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const top = src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx;
      const bot = src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx;
      dst[y * dw + x] = top * (1 - fy) + bot * fy;
    }
  }
  return dst;
}

/** Box-blur feather, radius 0-2 px (0 = no feather). */
export function featherMask(mask: Float32Array, w: number, h: number, radius = 1): Float32Array {
  const r = Math.max(0, Math.min(2, Math.round(radius)));
  if (r === 0) return new Float32Array(mask);
  const src = new Float32Array(mask);
  const dst = new Float32Array(mask.length);
  const size = (r * 2 + 1) * (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        sum += src[ny * w + nx];
        count++;
      }
      dst[y * w + x] = sum / Math.max(1, count);
      void size;
    }
  }
  return dst;
}

/** Guided-filter approximation: edge-aware smoothing of the mask against the image. */
export function guidedFilterMaskApprox(
  mask: Float32Array,
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  radius = 2,
): Float32Array {
  const r = Math.max(0, Math.min(4, Math.round(radius)));
  if (r === 0) return new Float32Array(mask);
  const out = new Float32Array(mask.length);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]) / 255;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sumM = 0;
      let sumL = 0;
      let sumML = 0;
      let sumLL = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const idx = ny * w + nx;
        sumM += mask[idx];
        sumL += lum[idx];
        sumML += mask[idx] * lum[idx];
        sumLL += lum[idx] * lum[idx];
        count++;
      }
      const meanM = sumM / count;
      const meanL = sumL / count;
      const meanML = sumML / count;
      const meanLL = sumLL / count;
      const varL = Math.max(1e-6, meanLL - meanL * meanL);
      const cov = meanML - meanM * meanL;
      // eps favours sharp edges: hard to follow, preserves detail.
      const a = cov / (varL + 0.01);
      const b = meanM - a * meanL;
      out[y * w + x] = Math.max(0, Math.min(1, a * lum[y * w + x] + b));
    }
  }
  return out;
}

/** Applies a soft mask to RGBA pixels in place: alpha' = alpha * mask. */
export function applyMaskToPixels(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  mask: Float32Array,
): void {
  for (let i = 0; i < w * h; i++) {
    const m = Math.max(0, Math.min(1, mask[i]));
    pixels[i * 4 + 3] = Math.round(pixels[i * 4 + 3] * m);
  }
}

/**
 * Removes one extra colour globally (the colour-pick tool). Border-connected
 * restriction is NOT applied here: the user explicitly asked to remove this
 * colour everywhere.
 */
export function removeExtraColourFromPixels(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  target: { r: number; g: number; b: number },
  tolerance = 32,
): void {
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    if (pixels[p + 3] === 0) continue;
    const dr = pixels[p] - target.r;
    const dg = pixels[p + 1] - target.g;
    const db = pixels[p + 2] - target.b;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d <= tolerance) pixels[p + 3] = 0;
  }
}
