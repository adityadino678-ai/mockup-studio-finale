// Regenerates the store icons (16/32/48/128) from the ListBulkly logo SVG.
// Run from the repo root: node extension/tools/make-icons.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
const sharp = require2("sharp");
const here = path.dirname(fileURLToPath(import.meta.url));
// The logo lives two levels above the repo root's parent? No: repo root is 2 up
// from extension/tools, and the SVG sits next to the repo root folder.
const svgPath = path.resolve(here, "../../../lb-icon.svg");
const outDir = path.resolve(here, "../icons");

const svg = fs.readFileSync(svgPath, "utf8");
// viewBox is 1100x1100 at offset 212,-72; normalise to a full-canvas 1100x1100 icon
const normalised = svg
  .replace(/viewBox="212 -72 1100 1100"/, 'viewBox="0 0 1100 1100"')
  .replace(
    /<rect x="212" y="-72" width="1100" height="1100" rx="220" fill="#FFFFFF"\/>/,
    '<rect x="0" y="0" width="1100" height="1100" rx="220" fill="#FFFFFF"/>'
  );

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp(Buffer.from(normalised), { density: 300 })
    .resize(size, size)
    .png()
    .toFile(path.join(outDir, `icon${size}.png`));
  console.log(`icon${size}.png written`);
}
