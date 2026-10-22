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

/**
 * Runs `action` until it stops throwing, tolerating a dev-server reload.
 *
 * The Astro dev server reloads the page when it re-optimises a lazy import,
 * and it can also lose a race with OneDrive's sync of its own content store
 * (`.astro/data-store.json`). A reload resets the React state, so a test
 * that depends on transient UI state - an open panel, a selected tab - has to
 * survive it. The app itself is fine: production serves static files and has
 * no Vite at all.
 *
 * `action` must therefore be safe to run more than once.
 */
async function toleratingReload(page: Page, action: () => Promise<void>) {
  await expect(async () => {
    await action();
  }).toPass({ timeout: 60_000, intervals: [500, 1000, 2000, 3000] });
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

    // The dialog reports how much it removed; the cut-out itself is proved
    // by the pixels below, not by the wording.
    await expect(page.getByText(/background removed/i).first()).toBeVisible({ timeout: 30_000 });
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
    // Integrations report an HONEST state for whatever configuration exists.
    // In CI no key is present, so the state is "not configured"; a developer
    // running locally with a key in .dev.vars gets the connected state. Both
    // are correct, and neither may break anything else.
    const configured = await page.evaluate(async () => {
      const res = await fetch("/api/printify/catalog?limit=1");
      const data = await res.json();
      return Boolean(data.configured);
    });

    await gotoApp(page, "/products");
    if (configured) {
      await expect(page.getByText(/Connected — \d+ blueprints available/)).toBeVisible({ timeout: 20_000 });
    } else {
      await expect(page.getByText("Not configured. Local drafts work without an account.")).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/Add PRINTIFY_API_KEY/).first()).toBeVisible();
    }

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
      "/", "/agent", "/designs", "/mockups", "/editor", "/batch", "/templates",
      "/products", "/listings", "/export", "/seo", "/activity", "/settings",
      "/printify-studio",
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
      { link: /^Agent$/, path: "/agent", copy: /How can I help\?/ },
      { link: /^Designs$/, path: "/designs", copy: /Your artwork library/ },
      { link: /^Mockups$/, path: "/mockups", copy: /Photos of your products/ },
      { link: /^Mockup Editor$/, path: "/editor", copy: /Pick a design/ },
      { link: /^Batch Studio$/, path: "/batch", copy: /No batch jobs yet/ },
      { link: /^Printify Studio$/, path: "/printify-studio", copy: /Upload designs, choose the product/ },
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
      // Cloudflare static assets 307-redirect `/designs` to `/designs/`, while
      // `astro dev` serves it unslashed - so match an optional trailing slash.
      const escaped = section.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await page.waitForURL(new RegExp(`${escaped.replace(/\/$/, "")}\\/?$`));
      await expect(page.locator("main")).toContainText(section.copy, { timeout: 30_000 });
    }
  });

  test("16. settings exposes a provider picker and key placeholders", async ({ page }) => {
    await gotoApp(page, "/settings");

    // Placeholders for the user's own Printify and AI credentials.
    await expect(page.getByLabel("Printify API key")).toBeVisible();
    await expect(page.getByLabel("Provider")).toBeVisible();
    await expect(page.getByLabel("AI API key")).toBeVisible();

    // Selecting a provider swaps the key placeholder to that provider's own.
    await page.getByLabel("Provider").selectOption("nvidia");
    await expect(page.getByLabel("AI API key")).toHaveAttribute("placeholder", /nvapi-/);

    // Nothing saved yet, so the Printify test button is disabled...
    const printifyTest = page.getByRole("button", { name: /Test connection/ }).first();
    await expect(printifyTest).toBeDisabled();

    // ...and typing a key enables it. (Not clicked: that would make a real
    // network call to Printify, which is out of scope for the offline suite.)
    await page.getByLabel("Printify API key").fill("pp_test_key_not_real");
    await expect(printifyTest).toBeEnabled();

    // Both the Printify and AI sections offer a connection test.
    await expect(page.getByRole("button", { name: /Test connection/ })).toHaveCount(2);

    // Keys are held in the browser's IndexedDB, never sent on save.
    await page.getByRole("button", { name: /Save keys/ }).click();
    await expect(page.getByText("Keys saved in this browser")).toBeVisible({ timeout: 15_000 });
    const stored = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      return new Promise<{ printifyKey?: string; activeProvider?: string } | undefined>((res) => {
        const rq = db
          .transaction(["settings"], "readonly")
          .objectStore("settings")
          .get("integrations");
        rq.onsuccess = () => res(rq.result?.value);
      });
    });
    expect(stored?.printifyKey).toBe("pp_test_key_not_real");
    expect(stored?.activeProvider).toBe("nvidia");
  });

  test("17. agent page exposes sessions, composer and a model switcher", async ({ page }) => {    await gotoApp(page, "/agent");

    // Sessions rail with a search box and a New chat button.
    await expect(page.getByRole("button", { name: /New chat/ })).toBeVisible();
    await expect(page.getByPlaceholder("Search chats")).toBeVisible();

    // Empty state, and the composer is offered.
    await expect(page.getByText("How can I help?")).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message the agent" });
    await expect(composer).toBeVisible();

    // The combined provider/model picker lives in the composer.
    await expect(page.getByRole("button", { name: /Choose model/ })).toBeVisible();

    // With no provider key, the composer is disabled and a CTA points at Settings.
    await expect(composer).toBeDisabled();
    await expect(page.getByRole("link", { name: /Add an AI provider key/ })).toBeVisible();

    // The floating launcher is hidden on the agent page itself.
    await expect(page.getByRole("link", { name: /Open the agent/ })).toHaveCount(0);

    // The workspace rail (shown at xl) lists real artifacts and can be toggled.
    await expect(page.getByText("stored in this browser")).toBeVisible();
    await page.getByRole("button", { name: "Hide workspace rail" }).click();
    await expect(page.getByText("stored in this browser")).toHaveCount(0);
  });

  test("18. the ink-row checkbox moves a design, survives a reload, and backgrounds are removed", async ({
    page,
  }) => {
    await gotoApp(page, "/printify-studio");
    await page.setInputFiles('input[type=file]', [
      fixture("design-a.png"),
      fixture("design-solid.png"),
    ]);
    // Both designs start in the "no ink variants" row: nothing is inferred
    // from the artwork on file.
    await expect(page.getByText("No ink variants (2)")).toBeVisible({ timeout: 30_000 });
    // The empty row is SHOWN, not hidden: a row the user cannot see the
    // meaning of is a row the split is invisible in.
    await expect(page.getByText("Has ink variants (0)")).toBeVisible();
    await expect(page.getByText("No designs with ink variants yet")).toBeVisible();

    // The user decides: one tick and the design moves to the other row.
    await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
    await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Has ink variants (1)")).toBeVisible();

    // The tick is the session's, so a reload cannot invent a different split.
    // The studio saves 400 ms after a change.
    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Has ink variants (1)")).toBeVisible();

    // Unticking puts it back - the box is the only switch.
    await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
    await expect(page.getByText("No ink variants (2)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Has ink variants (0)")).toBeVisible();

    // Background removal is a real edit, and the cutout is shown in place.
    await page.getByRole("checkbox", { name: "Select design-solid" }).click();
    await page.getByRole("button", { name: /^Remove background$/ }).click();
    await expect(page.getByText("cutout").first()).toBeVisible({ timeout: 30_000 });

    // The before/after wave is gone: the card shows the cutout, statically.
    await expect(page.locator(".studio-wave-layer")).toHaveCount(0);

    // No card may stick out of the row it belongs to. The rows are the
    // panels' width; a card wider than its grid track is what made the
    // gallery look broken.
    const layout = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("[data-design-card]"));
      const bad: string[] = [];
      for (const card of cards) {
        const row = card.closest("[data-design-row]");
        if (!row) {
          bad.push("card outside a row");
          continue;
        }
        const cr = card.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        // 1 px of tolerance for sub-pixel rounding.
        if (cr.left < rr.left - 1 || cr.right > rr.right + 1) {
          bad.push(card.getAttribute("data-design-card") ?? "unknown");
        }
      }
      return { cards: cards.length, bad };
    });
    expect(layout.cards).toBeGreaterThan(0);
    expect(layout.bad).toEqual([]);

    // The sub-tabs switch.
    await toleratingReload(page, async () => {
      await page.getByRole("tab", { name: "Colors" }).click();
      await expect(page.getByRole("tab", { name: "Colors" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.getByRole("tab", { name: "Design panel" }).click();
      await expect(page.getByRole("tab", { name: "Design panel" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  test("19. the design panel opens a placement-only adjustment panel that snaps to the centre", async ({
    page,
  }) => {
    await gotoApp(page, "/printify-studio");
    await page.setInputFiles('input[type=file]', [fixture("design-a.png")]);
    await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 30_000 });

    // The Designs tab shows BOTH rows, including the empty one.
    await expect(page.getByText("Has ink variants (0)")).toBeVisible();
    await expect(page.getByText("No designs with ink variants yet")).toBeVisible();

    // The Design panel tab shows both rows too, above the listing.
    await toleratingReload(page, async () => {
      await page.getByRole("tab", { name: "Design panel" }).click();
      await expect(page.getByRole("tab", { name: "Design panel" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    await expect(page.locator('[data-design-row="plain"]')).toBeVisible();
    await expect(page.locator('[data-design-row="ink"]')).toBeVisible();
    await expect(page.getByText("Has ink variants (0)")).toBeVisible();

    const panel = page.locator("[data-design-panel]");

    /** Opens the adjustment panel for the only design, if it is not open. */
    async function openPanel() {
      if ((await panel.count()) > 0) return;
      await page.getByRole("tab", { name: "Design panel" }).click();
      await page.getByRole("button", { name: "Open design-a" }).click();
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }

    // Clicking a card opens a SEPARATE panel that holds nothing but the
    // placement.
    await toleratingReload(page, openPanel);
    await expect(panel.getByText("Adjust \"design-a\"")).toBeVisible();

    // ... and nothing else: no title template, no price, no colour list.
    await expect(panel.getByText("Title template")).toHaveCount(0);
    await expect(panel.getByText(/^Price/i)).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /Create on Printify/ })).toHaveCount(0);

    // Dragging the artwork 4 px off the centre snaps it back to the centre:
    // the symmetry snap, measured in screen pixels.
    await toleratingReload(page, async () => {
      await openPanel();
      const preview = panel.locator('[role="img"]');
      await expect(preview).toBeVisible({ timeout: 5_000 });
      const box = await preview.boundingBox();
      expect(box).not.toBeNull();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 4, cy - 3, { steps: 4 });
      await page.mouse.up();
      await expect(panel.locator("#studio-x")).toHaveValue("0.5");
      await expect(panel.locator("#studio-y")).toHaveValue("0.5");
    });

    // The rotation handle snaps to the 15 degree grid: dragging it to 88
    // degrees lands on exactly 90.
    await toleratingReload(page, async () => {
      await openPanel();
      const preview = panel.locator('[role="img"]');
      await expect(preview).toBeVisible({ timeout: 5_000 });
      const handle = preview.locator("[data-rotate-handle]");
      await expect(handle).toBeVisible({ timeout: 5_000 });
      const pbox = await preview.boundingBox();
      const hbox = await handle.boundingBox();
      expect(pbox).not.toBeNull();
      expect(hbox).not.toBeNull();
      const cx = pbox!.x + pbox!.width / 2;
      const cy = pbox!.y + pbox!.height / 2;
      await page.mouse.move(hbox!.x + hbox!.width / 2, hbox!.y + hbox!.height / 2);
      await page.mouse.down();
      // The handle sits "above" the centre at angle 0, so an artwork angle of
      // 88 degrees is a pointer angle of -2 degrees.
      const r = Math.min(pbox!.width, pbox!.height) / 4;
      const target = (-2 * Math.PI) / 180;
      await page.mouse.move(cx + Math.cos(target) * r, cy + Math.sin(target) * r, {
        steps: 4,
      });
      await page.mouse.up();
      await expect(panel.locator("#studio-angle")).toHaveValue("90");
    });
  });

  test("20. a mockup gets a print area that survives a refresh", async ({ page }) => {
    await seedLibrary(page);
    await gotoApp(page, "/mockups");

    // The upper section of the Mockups page has two tabs now.
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await expect(page.locator("#area-preset")).toBeVisible({ timeout: 30_000 });

    // A preset gives the mockup a real Printify area size.
    await page.locator("#area-preset").click();
    await page.getByRole("option", { name: /Tee · DTG front/ }).click();
    await expect(page.getByText("4500 × 5400 px")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Tee · DTG front", { exact: true })).toBeVisible({ timeout: 10_000 });

    // Saving it stores it on the mockup, and it is still there after a reload.
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await expect(page.getByText("4500×5400")).toBeVisible({ timeout: 30_000 });
  });

  test("25. the editor follows the Studio and clips to the print area", async ({ page }) => {
    const { designId, mockupId } = await seedLibrary(page);

    // A print area on the mockup.
    await gotoApp(page, "/mockups");
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await page.locator("#area-preset").waitFor({ timeout: 30_000 });
    await page.locator("#area-preset").click();
    await page.getByRole("option", { name: /Tee · DTG front/ }).click();
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });

    // A design twice as wide as the area, so there is something to clip.
    await gotoApp(page, "/printify-studio");
    await toleratingReload(page, async () => {
      await page.getByRole("tab", { name: "Design panel" }).click();
      await page.getByRole("button", { name: "Open design-a" }).click();
    });
    await expect(page.locator("#studio-scale")).toBeVisible({ timeout: 30_000 });
    await page.locator("#studio-scale").fill("200");
    await page.locator("#studio-scale").press("Enter");
    await page.waitForTimeout(500);

    // The editor takes the Studio's placement for a mockup with an area.
    await gotoApp(page, "/editor?design=" + designId + "&mockup=" + mockupId);
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);

    // The area is 4500 x 5400 on a 1200 x 1200 photo; the frame sits at 50% /
    // 30% of the photo and the design is 200% of the area's width = 80% of it.
    const fields = page.getByRole("spinbutton");
    await expect(fields.nth(0)).toHaveValue("50");
    await expect(fields.nth(1)).toHaveValue("30");
    await expect(fields.nth(2)).toHaveValue("80");

    // The design is clipped to the area: the painted red is the AREA's shape
    // (4500 x 5400, so 0.833 wide per tall), not the artwork's own square.
    const painted = await page.evaluate(() => {
      const el = document.querySelector("canvas") as HTMLCanvasElement;
      const ctx = el.getContext("2d")!;
      const data = ctx.getImageData(0, 0, el.width, el.height).data;
      let minX = 1e9;
      let maxX = -1;
      let minY = 1e9;
      let maxY = -1;
      let reds = 0;
      for (let y = 0; y < el.height; y++) {
        for (let x = 0; x < el.width; x++) {
          const i = (y * el.width + x) * 4;
          if (data[i] > 150 && data[i + 1] < 90 && data[i + 2] < 90) {
            reds++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { reds, width: maxX - minX, height: maxY - minY };
    });

    expect(painted.reds).toBeGreaterThan(1000);
    // The painted area is the print area's shape (4500/5400 = 0.833).
    expect(painted.width / painted.height).toBeCloseTo(4500 / 5400, 1);
  });
  test("26. the print area clips the design in a rendered output", async ({ page }) => {
    await seedLibrary(page);

    // A print area on the mockup.
    await gotoApp(page, "/mockups");
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await page.locator("#area-preset").waitFor({ timeout: 30_000 });
    await page.locator("#area-preset").click();
    await page.getByRole("option", { name: /Tee · DTG front/ }).click();
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });

    // A design that is WIDER than the print area: the part that falls outside
    // is not printable, so it must not appear on the product.
    await gotoApp(page, "/printify-studio");
    await toleratingReload(page, async () => {
      await page.getByRole("tab", { name: "Design panel" }).click();
      await page.getByRole("button", { name: "Open design-a" }).click();
    });
    await expect(page.locator("#studio-scale")).toBeVisible({ timeout: 30_000 });
    await page.locator("#studio-scale").fill("200");
    await page.locator("#studio-scale").press("Enter");
    await page.waitForTimeout(500);

    // The mockup follows the Studio: the design is 200% of the area width.
    await gotoApp(page, "/mockups");
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await expect(page.getByText(/200% of the print area/)).toBeVisible({ timeout: 30_000 });

    // Render it.
    await gotoApp(page, "/batch");
    await page.getByRole("checkbox", { name: /design-a/ }).click();
    await page.getByRole("checkbox", { name: /mockup-a/ }).click();
    await page.getByRole("button", { name: /Start job/ }).click();
    await expect(page.getByText("1 done").first()).toBeVisible({ timeout: 90_000 });

    const samples = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const metas: Array<{ id: string }> = await new Promise((res) => {
        const rq = db.transaction(["assets"], "readonly").objectStore("assets").index("kind").getAll("mockup-render");
        rq.onsuccess = () => res(rq.result);
      });
      if (!metas.length) return { found: false as const };
      const blob: Blob = await new Promise((res) => {
        const rq = db.transaction(["blobs"], "readonly").objectStore("blobs").get(metas[0].id);
        rq.onsuccess = () => res(rq.result.blob);
      });
      const mockups: Array<{ width: number; height: number; printArea?: { frame: { x: number; y: number; scale: number; rotation: number }; areaWidth: number; areaHeight: number } }> =
        await new Promise((res) => {
          const rq = db.transaction(["mockups"], "readonly").objectStore("mockups").getAll();
          rq.onsuccess = () => res(rq.result);
        });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);

      const mockup = mockups.find((m) => m.printArea);
      if (!mockup) return { found: false as const, reason: "no print area" };
      const area = mockup.printArea!;
      // The area's frame in photo pixels.
      const areaW = area.frame.scale * mockup.width;
      const areaH = areaW * (area.areaHeight / area.areaWidth);
      const areaX = (area.frame.x - area.frame.scale / 2) * mockup.width;
      const areaY = (area.frame.y - areaH / mockup.height / 2) * mockup.height;
      const areaCY = areaY + areaH / 2;
      return {
        found: true as const,
        width: bmp.width,
        height: bmp.height,
        // The design is 200% of the area's width and its red circle covers 70%
        // of the artwork, so the circle reaches well past the area's edges.
        //   justInside  - inside the area AND inside the red circle
        //   justOutside - outside the area, but still inside the red circle
        // The pair is the control: if justInside is red, the artwork really is
        // painted there, so a grey justOutside can only mean it was clipped.
        justInside: px(Math.round(areaX + areaW * 0.05), Math.round(areaCY)),
        justOutside: px(Math.round(areaX - areaW * 0.1), Math.round(areaCY)),
      };
    });

    expect(samples.found).toBe(true);
    if (samples.found) {
      // Just inside the area: the design's red.
      expect(samples.justInside[0]).toBeGreaterThan(samples.justInside[2] + 50);
      // Just outside it: NOT the design's red - it was cut off.
      expect(samples.justOutside[0]).toBeLessThan(samples.justOutside[2] + 50);
    }
  });

  test("27. the print area is a frame that carries the design", async ({ page }) => {
    await seedLibrary(page);

    await gotoApp(page, "/mockups");
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await page.locator("#area-preset").waitFor({ timeout: 30_000 });
    await page.locator("#area-preset").click();
    await page.getByRole("option", { name: /Tee · DTG front/ }).click();
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);

    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    const readFrame = () =>
      page.evaluate(async () => {
        const db: IDBDatabase = await new Promise((res) => {
          const r = indexedDB.open("mockup-studio");
          r.onsuccess = () => res(r.result);
        });
        const mockups: Array<{ printArea?: { frame: { x: number; y: number; scale: number; rotation: number } } }> =
          await new Promise((res) => {
            const rq = db.transaction(["mockups"], "readonly").objectStore("mockups").getAll();
            rq.onsuccess = () => res(rq.result);
          });
        return mockups.find((m) => m.printArea)?.printArea?.frame;
      });

    const before = await readFrame();
    expect(before).toBeTruthy();
    expect(before!.rotation).toBe(0);

    // The frame is turned by its own handle, above the frame's edge.
    const geometry = await page.evaluate(() => {
      const el = document.querySelector("canvas") as HTMLCanvasElement;
      const wrapper = el.parentElement!.parentElement!;
      const r = wrapper.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    const state = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const mockups: Array<{ width: number; height: number; printArea?: { frame: { x: number; y: number; scale: number; rotation: number }; areaWidth: number; areaHeight: number } }> =
        await new Promise((res) => {
          const rq = db.transaction(["mockups"], "readonly").objectStore("mockups").getAll();
          rq.onsuccess = () => res(rq.result);
        });
      return mockups.find((m) => m.printArea)!;
    });

    const stageScale = geometry.width / state.width;
    const frame = state.printArea!.frame;
    const cx = geometry.left + frame.x * state.width * stageScale;

    // The rotate handle is the only white thing on the frame's layer: find it
    // rather than compute where it should be.
    const handle = await page.evaluate(() => {
      const layers = document.querySelectorAll("canvas");
      const el = layers[1] as HTMLCanvasElement;
      const ctx = el.getContext("2d")!;
      const d = ctx.getImageData(0, 0, el.width, el.height).data;
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < el.height; y++) {
        for (let x = 0; x < el.width; x++) {
          const i = (y * el.width + x) * 4;
          if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250 && d[i + 3] > 250) {
            n++;
            sx += x;
            sy += y;
          }
        }
      }
      if (!n) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + sx / n, y: rect.top + sy / n };
    });
    expect(handle).toBeTruthy();
    const handleX = handle!.x;
    const handleY = handle!.y;
    expect(Math.abs(handleX - cx)).toBeLessThan(30);

    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      const a = (i / 10) * (Math.PI / 4);
      await page.mouse.move(
        handleX + Math.sin(a) * 110,
        handleY + (1 - Math.cos(a)) * 110,
      );
    }
    await page.mouse.up();
    await page.waitForTimeout(600);

    // The frame turned, and the turn is saved with it.
    await expect(page.getByText(/Frame \d+% of the photo/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });
    const after = await readFrame();
    expect(Math.abs(after!.rotation)).toBeGreaterThan(20);

    // Clicking the empty photo hides the frame's chrome; the design stays.
    // The chrome is the dashed outline AND the Transformer: the Transformer
    // lives outside the frame's group, so detaching its nodes is what stops
    // its border and its four corner anchors from being left on the design.
    const designInk = () =>
      page.evaluate(() => {
        const layers = document.querySelectorAll("canvas");
        const frameLayer = layers[1];
        const ctx = frameLayer.getContext("2d")!;
        const d = ctx.getImageData(0, 0, frameLayer.width, frameLayer.height).data;
        let reds = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) reds++;
        }
        return reds;
      });
    const chromeInk = () =>
      page.evaluate(() => {
        const layers = document.querySelectorAll("canvas");
        const chromeLayer = layers[2];
        if (!chromeLayer) return -1;
        const ctx = chromeLayer.getContext("2d")!;
        const d = ctx.getImageData(0, 0, chromeLayer.width, chromeLayer.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++;
        return painted;
      });

    expect(await designInk()).toBeGreaterThan(1000);
    expect(await chromeInk()).toBeGreaterThan(0);

    await page.mouse.click(geometry.left + 8, geometry.top + 8);
    await page.waitForTimeout(500);
    expect(await chromeInk()).toBe(0);
    expect(await designInk()).toBeGreaterThan(1000);

    // Clicking the design itself brings the chrome back.
    const design = await page.evaluate(() => {
      const el = document.querySelectorAll("canvas")[1] as HTMLCanvasElement;
      const d = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < el.height; y++) {
        for (let x = 0; x < el.width; x++) {
          const i = (y * el.width + x) * 4;
          if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) {
            n++;
            sx += x;
            sy += y;
          }
        }
      }
      if (!n) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + (sx / n) * (rect.width / el.width),
        y: rect.top + (sy / n) * (rect.height / el.height),
      };
    });
    expect(design).toBeTruthy();
    await page.mouse.click(design!.x, design!.y);
    await page.waitForTimeout(500);
    expect(await chromeInk()).toBeGreaterThan(0);
  });

  test("22. the studio's ink rows follow what the user ticks, not the product", async ({ page }) => {
    await gotoApp(page, "/printify-studio");
    await page.setInputFiles('input[type=file]', [
      fixture("design-a.png"),
      fixture("design-solid.png"),
    ]);
    await expect(page.getByText("No ink variants (2)")).toBeVisible({ timeout: 30_000 });

    // A product whose ink group is EMPTY: no colour of it needs the ink
    // artwork. That used to reshuffle the rows on its own. It no longer
    // does: only the checkbox separates the designs.
    await setStudioSession(page, {
      blueprintId: 6,
      printProviderId: 30,
      rows: {
        plain: { colors: ["White"], blackInkColors: [] },
        ink: { colors: [], blackInkColors: [] },
      },
    });
    await expect(page.getByText("No ink variants (2)")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Has ink variants (0)")).toBeVisible();

    // The user's tick still moves the design.
    await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
    await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Has ink variants (1)")).toBeVisible();

    // The split is stored, so the Design panel shows the same two rows, and
    // the box works there too.
    await page.waitForTimeout(900);
    await page.getByRole("tab", { name: "Design panel" }).click();
    await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Has ink variants (1)")).toBeVisible();

    await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
    await expect(page.getByText("Has ink variants (0)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No ink variants (2)")).toBeVisible();
  });

  test("23. the studio says why a PAIRED design cannot print every ink colour", async ({
    page,
  }) => {
    await gotoApp(page, "/printify-studio");
    await page.setInputFiles('input[type=file]', [fixture("design-a.png")]);
    await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 30_000 });

    // A product whose ink colours need the white ink, for a design that has
    // no ink artwork at all.
    await setStudioSession(page, {
      blueprintId: 6,
      printProviderId: 30,
      rows: {
        plain: { colors: [], blackInkColors: [] },
        ink: { colors: ["Black", "Navy"], blackInkColors: [] },
      },
    });
    await page.reload();
    await expect(page.getByRole("link", { name: /Batch Studio/ })).toBeVisible({ timeout: 30_000 });

    // The problems are about the batch that is about to be created, so the
    // design has to be ticked for it to have one.
    await page.getByRole("checkbox", { name: "Select design-a" }).click();
    await page.getByRole("tab", { name: "Design panel" }).click();
    await expect(page.getByRole("tab", { name: "Design panel" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // UNTICKED, the design prints one artwork on every colour on purpose.
    // That is a decision, not a defect, so nothing is reported.
    await expect(page.locator("[data-ink-problem]")).toHaveCount(0);

    // Tick it and the app says exactly what is missing - a plain sentence,
    // not "132 variants are not in any group".
    await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
    const problem = page.locator("[data-ink-problem]").first();
    await expect(problem).toBeVisible({ timeout: 30_000 });
    await expect(problem).toContainText(/white-ink artwork/i);
    await expect(problem).not.toContainText(/not in any group/i);

    // There is no one-click colour move any more: the two ways out are to
    // make the ink artwork, or to untick the box. The tick is the fix the
    // checkbox offers, and it works.
    await expect(page.locator("[data-move-to-plain]")).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
    await expect(page.locator("[data-ink-problem]")).toHaveCount(0, { timeout: 15_000 });
  });

  test("24. the hosted background-removal endpoint is gone", async ({ request }) => {
    // The remover is local now: two engines, no service, no key. The old
    // endpoint must not answer, so nothing can quietly start uploading the
    // user's artwork again.
    const response = await request.post("/api/bg-remove", {
      data: { image: "AAAA", mimeType: "image/png" },
      failOnStatusCode: false,
    });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    const body = await response.text();
    expect(body).not.toMatch(/background-removal key/i);
  });
});

/**
 * Sets the Printify Studio's stored session directly.
 *
 * The studio keeps its state in one row of the `settings` table, so the
 * product and its colour groups can be chosen without driving the whole
 * catalogue picker - and without needing a Printify key in the test.
 *
 * The page is left and re-entered on purpose. The studio holds the session
 * in memory and saves it a moment after any change, so writing to the store
 * while that page is open is overwritten by its own pending save - which is
 * a race that only shows up sometimes, and only on a fast machine.
 */
async function setStudioSession(page: Page, patch: Record<string, unknown>) {
  // A page that does not use the studio session, so nothing can save over it.
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Batch Studio/ })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async (changes) => {
    const db: IDBDatabase = await new Promise((res) => {
      const r = indexedDB.open("mockup-studio");
      r.onsuccess = () => res(r.result);
    });
    const read = await new Promise<{ value?: Record<string, unknown> } | undefined>((res) => {
      const rq = db.transaction(["settings"], "readonly").objectStore("settings").get(
        "printifyStudio:session",
      );
      rq.onsuccess = () => res(rq.result);
    });
    const session = { ...((read?.value ?? {}) as Record<string, unknown>), ...changes };
    await new Promise<void>((res) => {
      const tx = db.transaction(["settings"], "readwrite");
      tx.objectStore("settings").put({ key: "printifyStudio:session", value: session });
      tx.oncomplete = () => res();
    });
  }, patch);

  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: /Batch Studio/ })).toBeVisible({ timeout: 30_000 });
}

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