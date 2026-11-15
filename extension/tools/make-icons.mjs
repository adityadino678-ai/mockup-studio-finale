import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require2 = createRequire(import.meta.url);
const sharp = require2("sharp");
const here = path.dirname(fileURLToPath(import.meta.url));
const svgPath = path.resolve(here, "../../lb-l-icon.svg");
const outDir = path.resolve(here, "../icons");
const svg = fs.readFileSync(svgPath, "utf8");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png().toFile(path.join(outDir, `icon${size}.png`));
  console.log(`icon${size}.png written`);
}
