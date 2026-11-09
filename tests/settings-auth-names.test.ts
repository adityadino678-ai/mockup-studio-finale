import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("Settings sign-in form names", () => {
  it("every Input read via FormData.get() has a matching name attribute", async () => {
    const src = await readFile(
      path.resolve(process.cwd(), "src/views/settings-page.tsx"),
      "utf8",
    );
    const gets = [...src.matchAll(/formData\.get\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(gets).toContain("email");
    expect(gets).toContain("password");
    expect(gets).toContain("full_name");
    for (const key of gets) {
      expect(src).toContain(`name="${key}"`);
    }
  });
});
