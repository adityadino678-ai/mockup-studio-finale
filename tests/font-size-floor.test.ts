import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");

async function* walk(dir: string): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(tsx?|astro|css)$/.test(e.name)) yield full;
  }
}

describe("font-size floor (13px minimum)", () => {
  it("no arbitrary font size below 13px in src/", async () => {
    const offenders: string[] = [];
    for await (const file of walk(SRC)) {
      const text = await readFile(file, "utf8");
      // Catch text-[Npx] with N < 13. globals.css token definitions (--text-xs)
      // and landing exact.html are excluded: exact.html is owner-supplied verbatim.
      if (file.includes(`${path.sep}landing${path.sep}`)) continue;
      for (const m of text.matchAll(/text-\[(\d+)px\]/g)) {
        const px = Number(m[1]);
        if (px < 13) offenders.push(`${path.relative(process.cwd(), file)}: text-[${px}px]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("theme floors are set as specified", async () => {
    const css = await readFile(path.join(SRC, "styles", "globals.css"), "utf8");
    expect(css).toContain("--text-xs: 0.8125rem");
    expect(css).toContain("--text-sm: 0.9375rem");
    expect(css).toContain("--text-base: 1rem");
    expect(css).toContain("font-size: 100%");
    expect(css).toContain("font-size: 1rem");
  });
});
