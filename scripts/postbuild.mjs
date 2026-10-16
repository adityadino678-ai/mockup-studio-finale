import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Astro's Cloudflare adapter emits the Worker into `dist/_worker.js/`, and
 * `wrangler.jsonc` points `main` at that directory. Wrangler would otherwise
 * also upload `_worker.js` as a *public* asset, exposing server-side code to
 * the internet - it refuses to deploy unless told to skip it.
 *
 * `dist/` is regenerated on every build and is git-ignored, so the ignore file
 * has to be recreated each time. This runs automatically after `astro build`.
 */
const dist = path.resolve(import.meta.dirname, "..", "dist");

if (!existsSync(dist)) {
  console.error("[postbuild] dist/ not found - did astro build run?");
  process.exit(1);
}

await mkdir(dist, { recursive: true });
await writeFile(path.join(dist, ".assetsignore"), "_worker.js\n", "utf8");
console.log("[postbuild] wrote dist/.assetsignore (_worker.js)");
