// ---------------------------------------------------------------------------
// Edge refinement for the two local background removers.
//
// Both engines establish an alpha mask and then stop. On artwork that was
// flattened onto a background, the pixels the mask KEEPS can still be blends
// of the subject and that background: an anti-aliased edge over a near-black
// backdrop keeps a dark ring, because the pixel's RGB is (say) 50% subject and
// 50% backdrop even though its alpha was left at 255.
//
// This helper runs AFTER the mask exists and fixes exactly that ring:
//
//   1. Find the boundary band - kept pixels that touch removed ones.
//   2. Estimate the local BACKGROUND (from the removed neighbours, or from a
//      per-pixel estimate the caller already has) and the local FOREGROUND
//      (the most foreground-like opaque neighbour).
//   3. Recompute alpha by projecting the pixel onto the background->foreground
//      colour line. The projection parameter IS the coverage, so a 50% blend
//      becomes alpha 128 instead of 255. When the pixel is not on that line
//      the projection is not trustworthy, so only a distance ramp is applied,
//      and only to pixels the mask had already feathered.
//   4. Decontaminate the colour: un-blend the background out of the pixel so a
//      semi-transparent edge carries the subject's colour, not the backdrop's.
//   5. Smooth the feather a little and clean up single-pixel damage.
//
// Everything is a linear pass over the image with a 1-2 px neighbourhood:
// no full-image blur, no recursion, fully deterministic, no network.
//
// The rules that keep it safe:
//   - fully removed pixels (alpha 0) are never recoloured;
//   - fully opaque pixels that are NOT on the boundary (the artwork's
//     interior) are never touched at all;
//   - a pixel whose colour is not a plausible blend keeps its alpha.
// ---------------------------------------------------------------------------

/** Local background colour for a pixel, or null when it cannot be estimated. */
export type BackgroundAt = (x: number, y: number) => [number, number, number] | null;

export interface EdgeRefineOptions {
  /** Alpha at or below this counts as "removed" (background). */
  removedAlpha?: number;
  /** Alpha at or above this counts as "fully opaque" (foreground). */
  opaqueAlpha?: number;
  /** Neighbourhood radius, in pixels, for the local colour estimates. */
  sampleRadius?: number;
  /**
   * Explicit per-pixel background estimate. Omit to use the average of the
   * neighbouring removed pixels - which is what follows a gradient without
   * assuming one global background colour.
   */
  backgroundAt?: BackgroundAt;
}

export const EDGE_REFINE_DEFAULTS = {
  removedAlpha: 8,
  opaqueAlpha: 250,
  sampleRadius: 2,
} as const;

/** At least this much colour separation (0..255 RGB) is needed to project. */
const MIN_SEPARATION = 24;

/** The projection is only trusted when its t is inside this range. */
const MIN_COVERAGE = 0.06;
const MAX_DECOMPOSE = 0.94;

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function colorDistance(
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

interface Edit {
  idx: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Refines the edge of an established alpha mask, in place.
 *
 * `removedAlpha`/`opaqueAlpha` describe the mask; `backgroundAt` lets the
 * caller reuse a background estimate it already computed (the border model
 * does). Returns nothing - the buffer is the result.
 */
export function refineEdges(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: EdgeRefineOptions = {},
): void {
  const count = width * height;
  if (count === 0 || width < 3 || height < 3) return;

  const removedAlpha = Math.max(0, options.removedAlpha ?? EDGE_REFINE_DEFAULTS.removedAlpha);
  const opaqueAlpha = Math.min(255, Math.max(removedAlpha + 1, options.opaqueAlpha ?? EDGE_REFINE_DEFAULTS.opaqueAlpha));
  const sampleRadius = Math.max(1, Math.round(options.sampleRadius ?? EDGE_REFINE_DEFAULTS.sampleRadius));
  const backgroundAt = options.backgroundAt;

  // The working alpha. The pixels' own alpha stays untouched until the very
  // end, so every estimate reads the ORIGINAL mask.
  const alpha = new Uint8Array(count);
  for (let i = 0; i < count; i++) alpha[i] = pixels[i * 4 + 3];

  // The removed region. Kept separate from `alpha` so a speck that is cleaned
  // up later is not mistaken for a background sample.
  const removed = new Uint8Array(count);
  for (let i = 0; i < count; i++) removed[i] = alpha[i] <= removedAlpha ? 1 : 0;

  // The boundary band: kept pixels with a removed pixel in their 8-neighbour
  // ring. Kept to 1 px on purpose - a wider band would start "refining" the
  // artwork's interior detail, which is not a blend of anything.
  const band = new Uint8Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (removed[idx]) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (removed[ny * width + nx]) {
            edge = true;
            break;
          }
        }
      }
      if (edge) band[idx] = 1;
    }
  }

  const edits: Edit[] = [];
  const edited = new Uint8Array(count);

  // --- Morphology: isolated opaque specks inside the removed region ---------
  // One opaque pixel completely surrounded by background is noise. Only
  // pixels with all eight neighbours INSIDE the image are considered, so a
  // subject that runs off the edge is never bitten into.
  const specks: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (removed[idx] || alpha[idx] < opaqueAlpha) continue;
      let surrounded = true;
      for (let dy = -1; dy <= 1 && surrounded; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!removed[idx + dy * width + dx]) {
            surrounded = false;
            break;
          }
        }
      }
      if (surrounded) specks.push(idx);
    }
  }
  for (const idx of specks) {
    alpha[idx] = 0;
    const p = idx * 4;
    edits.push({ idx, r: pixels[p], g: pixels[p + 1], b: pixels[p + 2] });
    edited[idx] = 1;
  }

  // --- Morphology: 1 px pinholes inside the kept region ---------------------
  // A fully removed pixel enclosed by opaque pixels is a hole in the subject.
  // Fill it with the neighbours' colour so the print does not get a dot.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (!removed[idx] || alpha[idx] > removedAlpha) continue;
      let enclosed = true;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let samples = 0;
      for (let dy = -1; dy <= 1 && enclosed; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ni = idx + dy * width + dx;
          if (alpha[ni] < opaqueAlpha) {
            enclosed = false;
            break;
          }
          const p = ni * 4;
          sr += pixels[p];
          sg += pixels[p + 1];
          sb += pixels[p + 2];
          samples++;
        }
      }
      if (!enclosed || samples === 0) continue;
      alpha[idx] = 255;
      removed[idx] = 0;
      edits.push({
        idx,
        r: clamp255(sr / samples),
        g: clamp255(sg / samples),
        b: clamp255(sb / samples),
      });
      edited[idx] = 1;
    }
  }

  const estimateBackground = (x: number, y: number): [number, number, number] | null => {
    if (backgroundAt) return backgroundAt(x, y);
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let samples = 0;
    const y0 = Math.max(0, y - sampleRadius);
    const y1 = Math.min(height - 1, y + sampleRadius);
    const x0 = Math.max(0, x - sampleRadius);
    const x1 = Math.min(width - 1, x + sampleRadius);
    for (let ny = y0; ny <= y1; ny++) {
      const row = ny * width;
      for (let nx = x0; nx <= x1; nx++) {
        const ni = row + nx;
        if (ni === y * width + x || !removed[ni]) continue;
        const p = ni * 4;
        sr += pixels[p];
        sg += pixels[p + 1];
        sb += pixels[p + 2];
        samples++;
      }
    }
    if (samples === 0) return null;
    return [sr / samples, sg / samples, sb / samples];
  };

  /** The most foreground-like opaque neighbour: the one furthest from `bg`. */
  const estimateForeground = (
    x: number,
    y: number,
    bg: [number, number, number],
  ): [number, number, number] | null => {
    let best: [number, number, number] | null = null;
    let bestDistance = -1;
    const y0 = Math.max(0, y - sampleRadius);
    const y1 = Math.min(height - 1, y + sampleRadius);
    const x0 = Math.max(0, x - sampleRadius);
    const x1 = Math.min(width - 1, x + sampleRadius);
    for (let ny = y0; ny <= y1; ny++) {
      const row = ny * width;
      for (let nx = x0; nx <= x1; nx++) {
        const ni = row + nx;
        if (ni === y * width + x || alpha[ni] < opaqueAlpha) continue;
        const p = ni * 4;
        const d = colorDistance(pixels[p], pixels[p + 1], pixels[p + 2], bg[0], bg[1], bg[2]);
        if (d > bestDistance) {
          bestDistance = d;
          best = [pixels[p], pixels[p + 1], pixels[p + 2]];
        }
      }
    }
    if (!best || bestDistance < MIN_SEPARATION) return null;
    return best;
  };

  // --- The band itself ------------------------------------------------------
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (!band[idx] || edited[idx] || alpha[idx] === 0) continue;

      const p = idx * 4;
      const r = pixels[p];
      const g = pixels[p + 1];
      const b = pixels[p + 2];

      const bg = estimateBackground(x, y);
      if (!bg) continue;
      const fg = estimateForeground(x, y, bg);
      if (!fg) continue;

      const vr = fg[0] - bg[0];
      const vg = fg[1] - bg[1];
      const vb = fg[2] - bg[2];
      const lengthSq = vr * vr + vg * vg + vb * vb;
      if (lengthSq < MIN_SEPARATION * MIN_SEPARATION) continue;
      const length = Math.sqrt(lengthSq);

      const pr = r - bg[0];
      const pg = g - bg[1];
      const pb = b - bg[2];

      let t = (pr * vr + pg * vg + pb * vb) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;

      // How far the pixel sits from the background->foreground line. A real
      // blend lies on it; a differently-coloured detail does not.
      const wr = pr - t * vr;
      const wg = pg - t * vg;
      const wb = pb - t * vb;
      const residual = Math.sqrt(wr * wr + wg * wg + wb * wb);
      const reliable = residual <= Math.max(12, length * 0.3);

      let newAlpha = alpha[idx];
      let nr = r;
      let ng = g;
      let nb = b;

      if (reliable && t >= MIN_COVERAGE) {
        if (t >= MAX_DECOMPOSE) {
          // Essentially the foreground colour: fully opaque, no recolouring.
          newAlpha = 255;
        } else {
          newAlpha = clamp255(255 * t);
          // Un-blend: solve P = B + t * (F - B) for F.
          nr = clamp255(bg[0] + pr / t);
          ng = clamp255(bg[1] + pg / t);
          nb = clamp255(bg[2] + pb / t);
        }
      } else if (alpha[idx] < opaqueAlpha) {
        // Not a trustworthy blend. Fall back to a distance ramp, but only for
        // pixels the mask already feathered: an opaque interior detail keeps
        // its alpha.
        const ramp = Math.sqrt(pr * pr + pg * pg + pb * pb) / length;
        newAlpha = Math.min(alpha[idx], clamp255(255 * (ramp > 1 ? 1 : ramp)));
      }

      alpha[idx] = newAlpha;
      edits.push({ idx, r: nr, g: ng, b: nb });
      edited[idx] = 1;
    }
  }

  // --- A small alpha smoothing pass over the feather ------------------------
  // Only semi-transparent band pixels take part, and only they are averaged:
  // this removes the stair-stepping in the feather without bleeding the
  // artwork's opacity into it. Fully removed and fully opaque pixels are
  // untouched.
  const smoothed = new Uint8Array(alpha);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (!band[idx]) continue;
      const a = alpha[idx];
      if (a === 0 || a >= opaqueAlpha) continue;
      let sum = a * 2;
      let weight = 2;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ni = idx + dy * width + dx;
          if (!band[ni]) continue;
          const na = alpha[ni];
          if (na === 0 || na >= opaqueAlpha) continue;
          sum += na;
          weight++;
        }
      }
      smoothed[idx] = Math.round(sum / weight);
    }
  }

  // Write the mask back. RGB only changes for the edits above; interior and
  // fully removed pixels keep their exact colour.
  for (let i = 0; i < count; i++) pixels[i * 4 + 3] = smoothed[i];
  for (const edit of edits) {
    const p = edit.idx * 4;
    pixels[p] = edit.r;
    pixels[p + 1] = edit.g;
    pixels[p + 2] = edit.b;
  }
}

