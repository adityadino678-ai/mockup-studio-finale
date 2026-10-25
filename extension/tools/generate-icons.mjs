/* ---------------------------------------------------------------------------
 * generate-icons.mjs - makes the four placeholder PNG icons in extension/icons.
 *
 * PLACEHOLDERS ONLY: replace them with a real Mockup Studio icon before any
 * store submission (STORE.md says what the stores need). The current design is
 * a rounded forest-green button with a white mockup frame - the app's own
 * palette, because it is what was on screen.
 *
 * Not part of any build: plain Node with the built-in `zlib`/`fs` modules, no
 * dependencies, no package.json entry. Run it by hand if the icons need to be
 * regenerated:
 *
 *   node extension/tools/generate-icons.mjs
 * ------------------------------------------------------------------------- */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "icons");
const SIZES = [16, 32, 48, 128];
/* Rendered 4x larger and box-downsampled, or 16px would have no edges at all. */
const SS = 4;
const BACKGROUND = [47, 107, 79, 255]; // forest, the app's green
const INK = [255, 255, 255, 255];

/* ------------------------------------------------------------------ png */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function chunk(type, data) {
  const out = Buffer.concat([
    Buffer.from(u32(data.length)),
    Buffer.from(type, "latin1"),
    Buffer.from(data),
    Buffer.from(u32(crc32(Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)])))),
  ]);
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
          raw,
          rowStart + 1,
        );
  }
  const ihdr = Buffer.from([
    ...u32(width),
    ...u32(height),
    8, // bit depth
    6, // RGBA
    0, // deflate
    0, // adaptive filtering
    0, // no interlace
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ drawing */

function makeCanvas(width, height) {
  return { width, height, pixels: new Float32Array(width * height * 4) };
}

function blend(canvas, x, y, rgba, coverage) {
  if (coverage <= 0) return;
  const w = canvas.width;
  if (x < 0 || y < 0 || x >= w || y >= canvas.height) return;
  const i = (y * w + x) * 4;
  const a = (coverage * rgba[3]) / 255;
  for (let c = 0; c < 3; c++) canvas.pixels[i + c] = canvas.pixels[i + c] * (1 - a) + rgba[c] * a;
  canvas.pixels[i + 3] = canvas.pixels[i + 3] * (1 - a) + 255 * a;
}

/** Signed distance to a rounded rectangle (negative inside), in pixels. */
function sdRoundedRect(px, py, rect, radius) {
  const qx = Math.abs(px - (rect.x + rect.w / 2)) - (rect.w / 2 - radius);
  const qy = Math.abs(py - (rect.y + rect.h / 2)) - (rect.h / 2 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function fillRoundedRect(canvas, rect, radius, rgba) {
  for (let y = Math.floor(rect.y); y < Math.ceil(rect.y + rect.h); y++) {
    for (let x = Math.floor(rect.x); x < Math.ceil(rect.x + rect.w); x++) {
      const d = sdRoundedRect(x + 0.5, y + 0.5, rect, radius);
      blend(canvas, x, y, rgba, Math.max(0, Math.min(1, 0.5 - d)));
    }
  }
}

function strokeRoundedRect(canvas, rect, radius, line, rgba) {
  const lo = Math.min(rect.x, rect.y) - line;
  for (let y = Math.max(0, Math.floor(lo)); y < Math.ceil(rect.y + rect.h + line); y++) {
    for (let x = Math.max(0, Math.floor(lo)); x < Math.ceil(rect.x + rect.w + line); x++) {
      const d = Math.abs(sdRoundedRect(x + 0.5, y + 0.5, rect, radius));
      blend(canvas, x, y, rgba, Math.max(0, Math.min(1, line / 2 + 0.5 - d)));
    }
  }
}

function fillCircle(canvas, cx, cy, r, rgba) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      blend(canvas, x, y, rgba, Math.max(0, Math.min(1, 0.5 - d)));
    }
  }
}

/** A solid triangle via edge distances, so the 16px icon still reads as one. */
function fillTriangle(canvas, ax, ay, bx, by, cx, cy, rgba) {
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const w1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const w2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      const inside = w0 * area >= 0 && w1 * area >= 0 && w2 * area >= 0;
      if (!inside) continue;
      const edge = Math.min(
        Math.abs(w0) / Math.hypot(bx - ax, by - ay),
        Math.abs(w1) / Math.hypot(cx - bx, cy - by),
        Math.abs(w2) / Math.hypot(ax - cx, ay - cy),
      );
      blend(canvas, x, y, rgba, Math.max(0, Math.min(1, edge + 0.5)));
    }
  }
}

function downsample(canvas, size) {
  const out = new Uint8Array(size * size * 4);
  const factor = canvas.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * canvas.width + (x * factor + dx)) * 4;
          r += canvas.pixels[i];
          g += canvas.pixels[i + 1];
          b += canvas.pixels[i + 2];
          a += canvas.pixels[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      /* Straight alpha, no premultiplication surprises in a PNG. */
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

function drawIcon(size) {
  const canvas = makeCanvas(size * SS, size * SS);
  const S = size * SS;

  /* The button. */
  fillRoundedRect(canvas, { x: 0, y: 0, w: S, h: S }, S * 0.22, BACKGROUND);

  /* The mockup frame: white outline, inset from the button's edge. */
  const inset = S * 0.17;
  strokeRoundedRect(
    canvas,
    { x: inset, y: inset, w: S - inset * 2, h: S - inset * 2 },
    S * 0.1,
    S * 0.055,
    INK,
  );

  /* What sits inside a mockup: a small mountain and a sun. */
  fillTriangle(
    canvas,
    inset + S * 0.1,
    inset + S * 0.56,
    inset + S * 0.27,
    inset + S * 0.31,
    inset + S * 0.42,
    inset + S * 0.56,
    INK,
  );
  fillTriangle(
    canvas,
    inset + S * 0.35,
    inset + S * 0.56,
    inset + S * 0.47,
    inset + S * 0.37,
    inset + S * 0.57,
    inset + S * 0.56,
    INK,
  );
  fillCircle(canvas, inset + S * 0.63, inset + S * 0.29, S * 0.055, INK);

  return downsample(canvas, size);
}

/* ------------------------------------------------------------------ write */

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, size, Buffer.from(drawIcon(size)));
  writeFileSync(join(outDir, `icon${size}.png`), png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
