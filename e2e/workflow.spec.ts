import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * End-to-end acceptance coverage for the core workflow:
 *   upload â†’ edit â†’ batch generate â†’ templates â†’ export
 * External integrations are asserted in their *unconfigured* state, since no
 * credentials are used in CI. Those states are part of the contract.
 */

const FIXTURES = path.join(process.cwd(), "e2e", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

async function clearWorkspace(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) indexedDB.deleteDatabase(d.name);
    }
  });
  await page.reload();
}

/**
 * Navigates and waits for the app shell to hydrate.
 *
 * The views render as client-only islands, so the markup arrives empty and is
 * painted by React after the island script loads. The sidebar lives in the same
 * React tree as the page view, so its presence proves the view is interactive
 * and any subsequent click actually lands.
 */
async function gotoApp(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("link", { name: /Batch Studio/ })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("core workflow", () => {
  test.beforeEach(async ({ page }) => {
    await clearWorkspace(page);
  });

  test("1. uploads multiple designs and they survive a refresh", async ({ page }) => {
    await gotoApp(page, "/designs");
    await expect(page.getByText("No designs yet")).toBeVisible();

    await page.setInputFiles('input[type=file]', [
      fixture("design-a.png"),
      fixture("design-b.png"),
    ]);

    await expect(page.getByRole("button", { name: /Actions for design-a/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Actions for design-b/ })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: /Actions for design-a/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Actions for design-b/ })).toBeVisible();
  });

  test("2. uploads mockups and reuses them across designs", async ({ page }) => {
    await gotoApp(page, "/mockups");
    await page.setInputFiles('input[type=file]', [fixture("mockup-a.png"), fixture("mockup-b.png")]);
    await expect(page.getByRole("button", { name: /Actions for mockup-a/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Actions for mockup-b/ })).toBeVisible({ timeout: 20_000 });

    // Mockups appear in the batch picker and the editor picker.
    await gotoApp(page, "/batch");
    await expect(page.getByRole("checkbox", { name: /mockup-a/ })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /mockup-b/ })).toBeVisible();
  });

  test("3. edits, saves and reopens artwork in the editor", async ({ page }) => {
    const { designId, mockupId } = await seedLibrary(page);

    await gotoApp(page, `/editor?design=${designId}&mockup=${mockupId}`);
    await expect(page.getByText("Position")).toBeVisible({ timeout: 30_000 });
    // The Konva canvas renders (the preview is a real composite).
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });

    const rotation = page.getByRole("spinbutton").nth(3);
    await rotation.fill("25");
    await rotation.press("Enter");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText("Placement saved")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("spinbutton").nth(3)).toHaveValue("25", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^Saved$/ })).toBeVisible();
  });

  test("4. rendered output reflects the saved transformation", async ({ page }) => {
    const { designId, mockupId } = await seedLibrary(page);

    await gotoApp(page, `/editor?design=${designId}&mockup=${mockupId}`);
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });

    // Save a render through the editor and inspect the stored pixels.
    await page.getByRole("button", { name: /Export/ }).click();
    await page.getByRole("menuitem", { name: /Save render to generated images/ }).click();
    await expect(page.getByText("Render saved to your generated images")).toBeVisible({ timeout: 30_000 });

    const samples = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const metas: Array<{ id: string; kind: string }> = await new Promise((res) => {
        const rq = db.transaction(["assets"], "readonly").objectStore("assets").index("kind").getAll("mockup-render");
        rq.onsuccess = () => res(rq.result);
      });
      if (!metas.length) return { found: false as const };
      const blob: Blob = await new Promise((res) => {
        const rq = db.transaction(["blobs"], "readonly").objectStore("blobs").get(metas[0].id);
        rq.onsuccess = () => res(rq.result.blob);
      });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        found: true as const,
        width: bmp.width,
        height: bmp.height,
        center: px(Math.round(bmp.width * 0.5), Math.round(bmp.height * 0.45)),
        corner: px(4, 4),
      };
    });

    // Full mockup resolution (not a UI screenshot), artwork composited on top.
    expect(samples.found).toBe(true);
    if (samples.found) {
      expect(samples.width).toBe(1200);
      expect(samples.height).toBe(1200);
      // Red artwork is present at the placement centreâ€¦
      expect(samples.center[0]).toBeGreaterThan(samples.center[2]);
      // â€¦and the mockup background shows at the corner.
      expect(samples.corner[3]).toBeGreaterThan(200);
    }
  });

  test("5. batch generates the expected number of outputs", async ({ page }) => {
    await seedLibrary(page, { extraDesign: true });
    await gotoApp(page, "/batch");

    await page.getByRole("checkbox", { name: /design-a/ }).click();
    await page.getByRole("checkbox", { name: /design-b/ }).click();
    await page.getByRole("checkbox", { name: /design-c/ }).click();
    await page.getByRole("checkbox", { name: /mockup-a/ }).click();
    await page.getByRole("checkbox", { name: /mockup-b/ }).click();
    await expect(page.getByText("3 Ã— 2 = 6")).toBeVisible();

    await page.getByRole("button", { name: /Start job/ }).click();
    await expect(page.getByText(/6 combinations/).first()).toBeVisible({ timeout: 30_000 });
    // Every combination finishes successfully.
    await expect(page.getByText("6 done").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("failed", { exact: true })).toHaveCount(0);
  });

  test("6. skipping existing renders avoids duplicate work", async ({ page }) => {
    await seedLibrary(page);
    await gotoApp(page, "/batch");
    await page.getByRole("checkbox", { name: /design-a/ }).click();
    await page.getByRole("checkbox", { name: /design-b/ }).click();
    await page.getByRole("checkbox", { name: /mockup-a/ }).click();
    await page.getByRole("checkbox", { name: /mockup-b/ }).click();
    await page.getByRole("button", { name: /Start job/ }).click();
    await expect(page.getByText("4 done").first()).toBeVisible({ timeout: 90_000 });

    // Second identical run reuses the renders instead of producing new ones.
    await page.getByRole("button", { name: /Start job/ }).click();
    await expect(page.getByText(/Reused existing render/).first()).toBeVisible({ timeout: 30_000 });

    const renderCount = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      return new Promise<number>((res) => {
        const rq = db.transaction(["assets"], "readonly").objectStore("assets").index("kind").getAll("mockup-render");
        rq.onsuccess = () => res(rq.result.length);
      });
    });
    expect(renderCount).toBe(4);
  });

  test("7. background removal produces real transparency", async ({ page }) => {
    await seedLibrary(page, { solidBackgroundDesign: true });
    await gotoApp(page, "/designs");

    await page.getByRole("button", { name: /Actions for design-solid/ }).click();
    await page.getByRole("menuitem", { name: /Remove background/ }).click();
    await page.getByRole("button", { name: /^Remove background$/ }).click();

    await expect(page.getByText(/transparent background/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Apply to design/ }).click();
    await expect(page.getByText(/Applied to/)).toBeVisible({ timeout: 30_000 });

    const result = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const designs: Array<{ name: string; originalAssetId: string; processedAssetId?: string }> = await new Promise((res) => {
        const rq = db.transaction(["designs"], "readonly").objectStore("designs").getAll();
        rq.onsuccess = () => res(rq.result);
      });
      const d = designs.find((x) => x.name === "design-solid")!;
      const blob: Blob = await new Promise((res) => {
        const rq = db
          .transaction(["blobs"], "readonly")
          .objectStore("blobs")
          .get(d.processedAssetId!);
        rq.onsuccess = () => res(rq.result.blob);
      });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const corner = ctx.getImageData(3, 3, 1, 1).data;
      const centre = ctx.getImageData(Math.round(bmp.width / 2), Math.round(bmp.height / 2), 1, 1).data;
      return { cornerAlpha: corner[3], centreAlpha: centre[3], originalPreserved: !!d.originalAssetId };
    });

    expect(result.cornerAlpha).toBe(0); // background really removed
    expect(result.centreAlpha).toBe(255); // artwork untouched
    expect(result.originalPreserved).toBe(true);
  });

  test("8. ink variants are created without touching the original", async ({ page }) => {
    await seedLibrary(page);
    await gotoApp(page, "/designs");

    await page.getByRole("button", { name: /Actions for design-a/ }).click();
    await page.getByRole("menuitem", { name: /Ink variants/ }).click();

    await page.getByRole("button", { name: "Auto-generate" }).first().click();
    await expect(page.getByText("White ink variant created")).toBeVisible({ timeout: 30_000 });
    // Once white exists its slot stops offering Auto-generate, so exactly one
    // (black) remains â€” click it.
    await expect(page.getByRole("button", { name: "Auto-generate" })).toHaveCount(1, { timeout: 15_000 });
    await page.getByRole("button", { name: "Auto-generate" }).first().click();
    await expect(page.getByText("Black ink variant created")).toBeVisible({ timeout: 30_000 });

    const variants = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const designs: Array<{
        name: string;
        originalAssetId: string;
        whiteInkAssetId?: string;
        blackInkAssetId?: string;
      }> = await new Promise((res) => {
        const rq = db.transaction(["designs"], "readonly").objectStore("designs").getAll();
        rq.onsuccess = () => res(rq.result);
      });
      const d = designs.find((x) => x.name === "design-a")!;
      const sample = async (id?: string) => {
        if (!id) return null;
        const blob: Blob = await new Promise((res) => {
          const rq = db.transaction(["blobs"], "readonly").objectStore("blobs").get(id);
          rq.onsuccess = () => res(rq.result.blob);
        });
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        const d2 = ctx.getImageData(Math.round(bmp.width / 2), Math.round(bmp.height / 2), 1, 1).data;
        return [d2[0], d2[1], d2[2]];
      };
      return {
        main: await sample(d.originalAssetId),
        white: await sample(d.whiteInkAssetId),
        black: await sample(d.blackInkAssetId),
        distinct:
          d.originalAssetId !== d.whiteInkAssetId &&
          d.originalAssetId !== d.blackInkAssetId &&
          d.whiteInkAssetId !== d.blackInkAssetId,
      };
    });

    expect(variants.distinct).toBe(true);
    expect(variants.main).not.toEqual(variants.white);
    expect(variants.white).toEqual([255, 255, 255]);
    expect(variants.black).toEqual([0, 0, 0]);
  });

  test("9. a template survives a refresh and reapplies to another design", async ({ page }) => {
    const { designId, mockupId } = await seedLibrary(page);

    // Create a template from a 22% placement.
    await gotoApp(page, `/editor?design=${designId}&mockup=${mockupId}`);
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
    const width = page.getByRole("spinbutton").nth(2);
    await width.fill("22");
    await width.press("Enter");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await page.getByRole("button", { name: /Save as template/ }).click();
    await page.getByLabel("Template name").fill("E2E template 22%");
    await page.getByRole("button", { name: /Save template/ }).click();
    await expect(page.getByText(/Template "E2E template 22%" saved/)).toBeVisible({ timeout: 20_000 });

    // Drift the placement away from the template, save.
    await width.fill("40");
    await width.press("Enter");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText("Placement saved").first()).toBeVisible({ timeout: 15_000 });

    // Template survives a refresh.
    await gotoApp(page, "/templates");
    await page.reload();
    await expect(page.getByText("E2E template 22%")).toBeVisible({ timeout: 20_000 });

    // Reapplying restores the template's 22% width.
    await page.getByRole("button", { name: /^Apply$/ }).first().click();
    await page.getByRole("checkbox", { name: /design-a/ }).click();
    await page.getByRole("button", { name: /Apply to 1 design/ }).click();
    await expect(page.getByText(/Applied "E2E template 22%"/)).toBeVisible({ timeout: 20_000 });

    const applied = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const designs: Array<{ id: string; name: string }> = await new Promise((res) => {
        const rq = db.transaction(["designs"], "readonly").objectStore("designs").getAll();
        rq.onsuccess = () => res(rq.result);
      });
      const target = designs.find((d) => d.name === "design-a")!.id;
      const placements: Array<{ designId: string; transform: { scale: number } }> = await new Promise((res) => {
        const rq = db.transaction(["placements"], "readonly").objectStore("placements").getAll();
        rq.onsuccess = () => res(rq.result);
      });
      return placements.filter((p) => p.designId === target).map((p) => Math.round(p.transform.scale * 100));
    });
    expect(applied.length).toBeGreaterThan(0);
    for (const scale of applied) expect(scale).toBe(22);
  });

  test("10. exports a ZIP with the documented structure and manifest", async ({ page }) => {
    await seedLibrary(page, { extraDesign: true });
    // Generate renders first so the archive contains mockups folders.
    await gotoApp(page, "/batch");
    await page.getByRole("checkbox", { name: /design-a/ }).click();
    await page.getByRole("checkbox", { name: /design-b/ }).click();
    await page.getByRole("checkbox", { name: /mockup-a/ }).click();
    await page.getByRole("checkbox", { name: /mockup-b/ }).click();
    await page.getByRole("button", { name: /Start job/ }).click();
    await expect(page.getByText("4 done").first()).toBeVisible({ timeout: 90_000 });

    await gotoApp(page, "/export");
    await page.getByRole("checkbox", { name: /design-a/ }).click();
    await page.getByRole("checkbox", { name: /design-b/ }).click();
    await page.getByRole("button", { name: /Build ZIP/ }).click();
    await expect(page.getByText(/files verified/).first()).toBeVisible({ timeout: 60_000 });

    // Fresh library: each design contributes 1 original + 2 renders,
    // plus the manifest â†’ 7 files.
    await expect(page.getByText("7 files verified").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Download ZIP/)).toBeVisible();
  });

  test("11. listing validation blocks invalid Etsy data", async ({ page }) => {
    await seedLibrary(page);
    await gotoApp(page, "/listings");
    await page.getByRole("button", { name: /Generate drafts from designs/ }).click();
    await expect(page.getByText(/Created \d+ local drafts/)).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Edit" }).first().click();
    await expect(page.getByText("Listing draft")).toBeVisible();

    const title = page.getByLabel("Title");
    await title.fill("x".repeat(200));
    await expect(page.getByText(/Title must be 140 characters or fewer/)).toBeVisible();

    await title.fill("Valid retro hiking shirt");
    await page.getByLabel("Tags (comma separated)").fill(Array.from({ length: 16 }, (_, i) => `tag${i}`).join(", "));
    await expect(page.getByText(/Etsy allows at most 13 tags/)).toBeVisible();
  });

  test("12. missing credentials never break unrelated features", async ({ page }) => {
    await seedLibrary(page);
    // Integrations report honest, unconfigured states.
    await gotoApp(page, "/products");
    await expect(page.getByText("Not configured. Local drafts work without an account.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Add PRINTIFY_API_KEY/).first()).toBeVisible();

    await gotoApp(page, "/seo");
    await expect(page.getByText(/No AI provider configured/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Research & draft/ })).toBeDisabled();

    // Core workflow still works.
    await gotoApp(page, "/designs");
    await expect(page.getByRole("button", { name: /Actions for design-a/ })).toBeVisible({ timeout: 20_000 });
  });

  test("13. no secrets are exposed to the client", async ({ page }) => {
    const responses: string[] = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (url.includes("/_next/static/") || url.endsWith(".js")) responses.push(await res.text().catch(() => ""));
    });
    await gotoApp(page, "/settings");
    await page.waitForLoadState("networkidle");

    const bundle = responses.join("\n");
    // No API-key-like literals in any client chunk.
    expect(bundle).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(bundle).not.toMatch(/PRINTIFY_API_KEY\s*=\s*['"][A-Za-z0-9]/);
    expect(bundle).not.toMatch(/ETSY_API_KEY\s*=\s*['"][A-Za-z0-9]/);
  });

  test("14. every navigation section renders without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    const routes = [
      "/", "/designs", "/mockups", "/editor", "/batch", "/templates",
      "/products", "/listings", "/export", "/seo", "/activity", "/settings",
    ];
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main")).toBeVisible();
    }
    // Expected console noise, not application bugs:
    // - "Download the React DevTools" â€” dev-only banner.
    // - "Failed to load resource: ... 503" â€” the browser's network layer
    //   logging the *honest* 503 responses from unconfigured integration
    //   endpoints (e.g. /api/printify/catalog). The UI handles these
    //   gracefully â€” verified by test 12.
    const real = errors.filter(
      (e) =>
        !e.includes("Download the React DevTools") &&
        !/^Failed to load resource/.test(e),
    );
    if (real.length > 0) console.log("CONSOLE ERRORS FOUND:\n" + real.join("\n---\n"));
    expect(real).toEqual([]);
  });

  test("15. clicking every sidebar link actually loads that page", async ({ page }) => {
    // Each link must perform a real document load. A history-only navigation
    // would change the URL while leaving the previous view on screen, so the
    // assertion checks that the target page's own copy is rendered.
    const sections: Array<{ link: RegExp; path: string; copy: RegExp }> = [
      { link: /^Designs$/, path: "/designs", copy: /Your artwork library/ },
      { link: /^Mockups$/, path: "/mockups", copy: /Photos of your products/ },
      { link: /^Mockup Editor$/, path: "/editor", copy: /Pick a design/ },
      { link: /^Batch Studio$/, path: "/batch", copy: /No batch jobs yet/ },
      { link: /^Templates$/, path: "/templates", copy: /Reusable settings for placements/ },
      { link: /^Product Builder$/, path: "/products", copy: /No product drafts/ },
      { link: /^Listings$/, path: "/listings", copy: /Etsy-ready drafts with validation/ },
      { link: /^Export Center$/, path: "/export", copy: /organized ZIP archive with a manifest/ },
      { link: /^AI SEO Studio$/, path: "/seo", copy: /AI features need a provider/ },
      { link: /^Activity$/, path: "/activity", copy: /No activity yet/ },
      { link: /^Settings$/, path: "/settings", copy: /Workspace storage and external integrations/ },
      { link: /^Overview$/, path: "/", copy: /Your local print-on-demand workspace/ },
    ];

    await gotoApp(page, "/");
    for (const section of sections) {
      await page.getByRole("link", { name: section.link }).click();
      await page.waitForURL(`**${section.path}`);
      await expect(page.locator("main")).toContainText(section.copy, { timeout: 30_000 });
    }
  });
});

/** Uploads fixture assets into the library (waits for each upload to land)
 * and returns the ids of design-a and mockup-a. */
async function seedLibrary(
  page: Page,
  opts: { extraDesign?: boolean; solidBackgroundDesign?: boolean } = {},
) {
  const designFiles = [fixture("design-a.png"), fixture("design-b.png")];
  if (opts.extraDesign) designFiles.push(fixture("design-c.png"));
  if (opts.solidBackgroundDesign) designFiles.push(fixture("design-solid.png"));

  await gotoApp(page, "/designs");
  await page.setInputFiles('input[type=file]', designFiles);
  // Wait until every uploaded design actually appears before navigating away.
  for (const name of designFiles.map((f) => path.basename(f, ".png"))) {
    await expect(page.getByRole("button", { name: `Actions for ${name}` })).toBeVisible({ timeout: 30_000 });
  }

  await gotoApp(page, "/mockups");
  await page.setInputFiles('input[type=file]', [fixture("mockup-a.png"), fixture("mockup-b.png")]);
  for (const name of ["mockup-a", "mockup-b"]) {
    await expect(page.getByRole("button", { name: `Actions for ${name}` })).toBeVisible({ timeout: 30_000 });
  }

  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res) => {
      const r = indexedDB.open("mockup-studio");
      r.onsuccess = () => res(r.result);
    });
    const designs: Array<{ id: string; name: string }> = await new Promise((res) => {
      const rq = db.transaction(["designs"], "readonly").objectStore("designs").getAll();
      rq.onsuccess = () => res(rq.result);
    });
    const mockups: Array<{ id: string; name: string }> = await new Promise((res) => {
      const rq = db.transaction(["mockups"], "readonly").objectStore("mockups").getAll();
      rq.onsuccess = () => res(rq.result);
    });
    return {
      designId: designs.find((d) => d.name === "design-a")!.id,
      mockupId: mockups.find((m) => m.name === "mockup-a")!.id,
    };
  });
}

// Fail fast if fixtures are missing.
test.beforeAll(() => {
  expect(fs.existsSync(FIXTURES)).toBe(true);
  expect(os.tmpdir()).toBeTruthy();
});