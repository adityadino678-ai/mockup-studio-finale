import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * End-to-end acceptance coverage for the core workflow:
 *   upload â†’ place â†’ render â†’ export
 *
 * The app has six pages. The Designs library, the mockup editor, the batch
 * runner, templates, the Product Builder, listings and the AI SEO studio were
 * folded into these pages or removed, so their screens no longer exist and the
 * tests that drove them are gone. What is left probes the paths that still
 * ship, at the pixel level where it matters.
 *
 * External integrations are asserted in their *unconfigured* state, since no
 * credentials are used in CI. Those states are part of the contract.
 */

const FIXTURES = path.join(process.cwd(), "e2e", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

/**
 * Clears the app's IndexedDB, leaving the page on a working copy of the app.
 *
 * The old version called `indexedDB.deleteDatabase` from the page, which now
 * has its own Dexie connection open - a delete request is BLOCKED until every
 * connection closes, and a reload after an unawaited request is a race. The
 * CDP call force-clears the origin's IndexedDB without needing the page to
 * let go first.
 */
async function clearWorkspace(page: Page) {
  await page.goto("/printify-studio");
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Storage.clearDataForOrigin", {
      origin: new URL(page.url()).origin,
      storageTypes: "indexeddb",
    });
  } finally {
    await cdp.detach();
  }
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
async function gotoApp(page: Page, route: string) {
  await page.goto(route);
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({
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
    await gotoApp(page, "/printify-studio");
    await expect(page.getByText("No ink variants (0)")).toBeVisible();

    await page.setInputFiles('input[type=file]', [
      fixture("design-a.png"),
      fixture("design-b.png"),
    ]);

    await expect(
      page.getByRole("button", { name: "Actions for design-a", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: "Actions for design-b", exact: true }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Actions for design-a", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: "Actions for design-b", exact: true }),
    ).toBeVisible();
  });

  test("2. uploads mockups and they show up in the print-area picker", async ({ page }) => {
    await gotoApp(page, "/mockups");
    await page.setInputFiles('input[type=file]', [fixture("mockup-a.png"), fixture("mockup-b.png")]);
    await expect(
      page.getByRole("button", { name: "Actions for mockup-a", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: "Actions for mockup-b", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // The mockups are offered wherever a design can be placed on them.
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await expect(page.getByRole("button", { name: /mockup-a/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /mockup-b/ })).toBeVisible({ timeout: 30_000 });
  });

  test("3. designs can be renamed, tagged, searched, downloaded and duplicated", async ({
    page,
  }) => {
    await seedLibrary(page);
    // seedLibrary ends on /mockups; the design actions live in the Studio.
    await gotoApp(page, "/printify-studio");

    // Rename and tag: the dialog from the old Designs page.
    await page.getByRole("button", { name: "Actions for design-a", exact: true }).click();
    await page.getByRole("menuitem", { name: /Rename \/ tag/ }).click();
    await page.locator("#design-name").fill("design-a");
    await page.locator("#design-tags").fill("cat, christmas");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText("Design updated")).toBeVisible({ timeout: 15_000 });

    // The tag is a chip, and clicking it filters the gallery to that tag.
    const chip = page.getByRole("button", { name: "christmas", exact: true });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(
      page.getByRole("button", { name: "Actions for design-a", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Actions for design-b", exact: true }),
    ).toHaveCount(0);
    await chip.click();

    // A text search matches the name, and a miss says so instead of drawing
    // two empty rows that would both read "no designs yet".
    const search = page.getByLabel("Search designs and tags");
    await search.fill("design-b");
    await expect(
      page.getByRole("button", { name: "Actions for design-b", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Actions for design-a", exact: true }),
    ).toHaveCount(0);

    await search.fill("nothing-matches-this");
    await expect(page.getByText("No designs match")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(
      page.getByRole("button", { name: "Actions for design-a", exact: true }),
    ).toBeVisible();

    // Download saves the artwork under the design's own name.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Actions for design-a", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Download$/ }).click();
    expect((await download).suggestedFilename()).toBe("design-a.png");

    // Duplicate makes a real copy...
    await page.getByRole("button", { name: "Actions for design-a", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Duplicate$/ }).click();
    await expect(
      page.getByRole("button", { name: "Actions for design-a (copy)", exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // ...and deleting one card leaves the other alone.
    await page.getByRole("button", { name: "Actions for design-a (copy)", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Delete$/ }).click();
    await expect(
      page.getByRole("button", { name: "Actions for design-a (copy)", exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Actions for design-a", exact: true }),
    ).toBeVisible();
  });

  test("4. background removal produces real transparency", async ({ page }) => {
    await seedLibrary(page, { solidBackgroundDesign: true });
    await gotoApp(page, "/printify-studio");

    // One remover, inline: the card's menu starts the same sequential engine
    // the bulk button uses, with no separate dialog and no Apply step.
    await page.getByRole("button", { name: "Actions for design-solid", exact: true }).click();
    await page.getByRole("menuitem", { name: /Remove background/ }).click();
    await expect(page.getByText(/Removed the background from 1 design/)).toBeVisible({
      timeout: 60_000,
    });

    const result = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const designs: Array<{ name: string; originalAssetId: string; processedAssetId?: string }> =
        await new Promise((res) => {
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

  test("5. ink variants are created without touching the original", async ({ page }) => {
    await seedLibrary(page);
    await gotoApp(page, "/printify-studio");

    await page.getByRole("button", { name: "Actions for design-a", exact: true }).click();
    await page.getByRole("menuitem", { name: /Ink variants/ }).click();

    await page.getByRole("button", { name: "Auto-generate" }).first().click();
    await expect(page.getByText("White ink variant created")).toBeVisible({ timeout: 30_000 });
    // Once white exists its slot stops offering Auto-generate, so exactly one
    // (black) remains - click it.
    await expect(page.getByRole("button", { name: "Auto-generate" })).toHaveCount(1, {
      timeout: 15_000,
    });
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

  test("6. a saved render follows the placement and is clipped to the print area", async ({
    page,
  }) => {
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

    // Save the composed mockup. This is the same renderComposition the
    // agent's create_mockup_render tool calls.
    await page.getByRole("button", { name: /Save render/ }).click();
    await expect(page.getByText(/Mockup render saved/)).toBeVisible({ timeout: 60_000 });

    const samples = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const metas: Array<{ id: string }> = await new Promise((res) => {
        const rq = db
          .transaction(["assets"], "readonly")
          .objectStore("assets")
          .index("kind")
          .getAll("mockup-render");
        rq.onsuccess = () => res(rq.result);
      });
      if (!metas.length) return { found: false as const };
      const blob: Blob = await new Promise((res) => {
        const rq = db.transaction(["blobs"], "readonly").objectStore("blobs").get(metas[0].id);
        rq.onsuccess = () => res(rq.result.blob);
      });
      const mockups: Array<{
        width: number;
        height: number;
        printArea?: {
          frame: { x: number; y: number; scale: number; rotation: number };
          areaWidth: number;
          areaHeight: number;
        };
      }> = await new Promise((res) => {
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
      // Full mockup resolution, not a UI screenshot.
      expect(samples.width).toBe(1200);
      expect(samples.height).toBe(1200);
      // Just inside the area: the design's red.
      expect(samples.justInside[0]).toBeGreaterThan(samples.justInside[2] + 50);
      // Just outside it: NOT the design's red - it was cut off.
      expect(samples.justOutside[0]).toBeLessThan(samples.justOutside[2] + 50);
    }
  });

  test("7. exports a ZIP with the documented structure and manifest", async ({ page }) => {
    await seedLibrary(page);

    // One render on each mockup, from the Print areas tab.
    await gotoApp(page, "/mockups");
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await page.locator("#area-preset").waitFor({ timeout: 30_000 });
    await page.locator("#area-preset").click();
    await page.getByRole("option", { name: /Tee · DTG front/ }).click();
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Save render/ }).click();
    await expect(page.getByText(/Mockup render saved/)).toBeVisible({ timeout: 60_000 });
    // Wait for the toast to go before the next render, or its assertion would
    // pass on the first one's toast and the export would run too early.
    await expect(page.getByText(/Mockup render saved/)).toBeHidden({ timeout: 20_000 });

    // The other mockup: a different preset, because a Select does not fire
    // when its value has not changed.
    await page.getByRole("button", { name: /mockup-b/ }).click();
    await page.locator("#area-preset").click();
    await page.getByRole("option", { name: /Tee · DTG back/ }).click();
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Save render/ }).click();
    await expect(page.getByText(/Mockup render saved/)).toBeVisible({ timeout: 60_000 });

    await gotoApp(page, "/export");
    await page.getByRole("checkbox", { name: /design-a/ }).click();
    await page.getByRole("button", { name: /Build ZIP/ }).click();
    await expect(page.getByText(/files verified/).first()).toBeVisible({ timeout: 60_000 });

    // One design contributes its original + 2 renders, plus the manifest.
    await expect(page.getByText("4 files verified").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Download ZIP/)).toBeVisible();
  });

  test("8. missing credentials never break unrelated features", async ({ page }) => {
    await seedLibrary(page);

    // Integrations report an HONEST state for whatever configuration exists.
    // In CI no key is present, so the state is "not configured"; a developer
    // running locally with a key in .dev.vars gets the connected state. Both
    // are correct, and neither may break anything else.
    const state = await page.evaluate(async () => {
      const res = await fetch("/api/printify/catalog?limit=1");
      return { status: res.status, body: (await res.json()) as { configured?: boolean } };
    });
    expect(state.status).toBeLessThan(500);
    expect(typeof state.body.configured).toBe("boolean");

    // The core workflow does not depend on it.
    await gotoApp(page, "/printify-studio");
    await expect(
      page.getByRole("button", { name: "Actions for design-a", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("9. no secrets are exposed to the client", async ({ page }) => {
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

  test("10. every page renders without console errors, and / redirects to the Studio", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    const routes = ["/agent", "/mockups", "/export", "/activity", "/settings", "/printify-studio"];
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main")).toBeVisible();
    }

    // "/" is not a page any more: it is a static redirect to the Studio, so
    // the shell must end up on the Studio rather than render an empty root.
    await page.goto("/");
    await page.waitForURL(/\/printify-studio\/?$/, { timeout: 30_000 });
    await expect(page.locator("main")).toBeVisible();

    // Expected console noise, not application bugs:
    // - "Download the React DevTools" - dev-only banner.
    // - "Failed to load resource: ... 503" - the browser's network layer
    //   logging the *honest* 503 responses from unconfigured integration
    //   endpoints (e.g. /api/printify/catalog). The UI handles these
    //   gracefully - verified by test 8.
    const real = errors.filter(
      (e) =>
        !e.includes("Download the React DevTools") &&
        !/^Failed to load resource/.test(e),
    );
    if (real.length > 0) console.log("CONSOLE ERRORS FOUND:\n" + real.join("\n---\n"));
    expect(real).toEqual([]);
  });

  test("11. clicking every sidebar link actually loads that page", async ({ page }) => {
    // Each link must perform a real document load. A history-only navigation
    // would change the URL while leaving the previous view on screen, so the
    // assertion checks that the target page's own copy is rendered.
    const sections: Array<{ link: RegExp; path: string; copy: RegExp }> = [
      { link: /^Mockups$/, path: "/mockups", copy: /Photos of your products/ },
      { link: /^Printify Studio$/, path: "/printify-studio", copy: /Upload designs, choose the product/ },
      { link: /^Agent$/, path: "/agent", copy: /How can I help\?/ },
      { link: /^Export Center$/, path: "/export", copy: /organized ZIP archive with a manifest/ },
      { link: /^Activity$/, path: "/activity", copy: /No activity yet/ },
      { link: /^Settings$/, path: "/settings", copy: /Workspace storage and external integrations/ },
    ];

    await gotoApp(page, "/printify-studio");

    // The eight pages folded away must not be reachable from the sidebar.
    for (const gone of [
      "Overview",
      "Designs",
      "Mockup Editor",
      "Batch Studio",
      "Templates",
      "Product Builder",
      "Listings",
      "AI SEO Studio",
    ]) {
      await expect(page.getByRole("link", { name: gone, exact: true })).toHaveCount(0);
    }

    for (const section of sections) {
      await page.getByRole("link", { name: section.link }).click();
      // Cloudflare static assets 307-redirect `/mockups` to `/mockups/`, while
      // `astro dev` serves it unslashed - so match an optional trailing slash.
      const escaped = section.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await page.waitForURL(new RegExp(`${escaped.replace(/\/$/, "")}\\/?$`));
      await expect(page.locator("main")).toContainText(section.copy, { timeout: 30_000 });
    }
  });

  test("12. settings exposes a provider picker and key placeholders", async ({ page }) => {
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

  test("13. agent page exposes sessions, composer and a model switcher", async ({ page }) => {
    await gotoApp(page, "/agent");

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

  test("14. the ink-row checkbox moves a design, survives a reload, and backgrounds are removed", async ({
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
    await expect(page.getByText(/Removed the background from 1 design/)).toBeVisible({
      timeout: 60_000,
    });
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

  test("15. the design panel opens a placement-only adjustment panel that snaps to the centre", async ({
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

  test("16. a mockup gets a print area that survives a refresh", async ({ page }) => {
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

  test("17. the print area is a frame that carries the design", async ({ page }) => {
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
        const mockups: Array<{
          printArea?: { frame: { x: number; y: number; scale: number; rotation: number } };
        }> = await new Promise((res) => {
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
      const mockups: Array<{
        width: number;
        height: number;
        printArea?: {
          frame: { x: number; y: number; scale: number; rotation: number };
          areaWidth: number;
          areaHeight: number;
        };
      }> = await new Promise((res) => {
        const rq = db.transaction(["mockups"], "readonly").objectStore("mockups").getAll();
        rq.onsuccess = () => res(rq.result);
      });
      return mockups.find((m) => m.printArea)!;
    });

    const stageScale = geometry.width / state.width;
    const frame = state.printArea!.frame;
    const cx = geometry.left + frame.x * state.width * stageScale;

    // The rotate handle is the only white thing on the knob's own layer: find
    // it rather than compute where it should be. It is painted last, in its
    // own layer, so nothing can sit over it.
    const handle = await page.evaluate(() => {
      const layers = document.querySelectorAll("canvas");
      const el = layers[3] as HTMLCanvasElement;
      const ctx = el.getContext("2d")!;
      const d = ctx.getImageData(0, 0, el.width, el.height).data;
      let n = 0;
      let sx = 0;
      let sy = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      for (let y = 0; y < el.height; y++) {
        for (let x = 0; x < el.width; x++) {
          const i = (y * el.width + x) * 4;
          // The knob's painted extent: its white fill AND its stroke. The
          // stem is a thin vertical line above it, so it cannot widen this.
          if (d[i + 3] > 8) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
          }
          if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250 && d[i + 3] > 250) {
            n++;
            sx += x;
            sy += y;
          }
        }
      }
      if (!n) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + sx / n,
        y: rect.top + sy / n,
        // The painted dot, in SCREEN pixels.
        painted: (maxX - minX + 1) * (rect.width / el.width),
      };
    });
    expect(handle).toBeTruthy();
    const handleX = handle!.x;
    const handleY = handle!.y;
    expect(Math.abs(handleX - cx)).toBeLessThan(30);
    // A 6 px radius dot was 12 px across - too small to hit. The knob is 8 px
    // and its hit region is wider still.
    expect(handle!.painted).toBeGreaterThan(14);

    // Grab it 10 px off its centre: outside the painted dot, INSIDE its hit
    // area. Before the knob got a hit width this drag missed the handle and
    // moved the frame instead, so the rotation assertion below is the test.
    await page.mouse.move(handleX + 10, handleY);
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

  test("18. the visible window cuts the design at the fold, and survives a reload", async ({
    page,
  }) => {
    await seedLibrary(page);

    await gotoApp(page, "/mockups");
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await page.locator("#area-preset").waitFor({ timeout: 30_000 });
    await page.locator("#area-preset").click();
    await page.getByRole("option", { name: /Tee · DTG front/ }).click();
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);

    const designInk = () =>
      page.evaluate(() => {
        const el = document.querySelectorAll("canvas")[1] as HTMLCanvasElement;
        const d = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
        let reds = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) reds++;
        }
        return reds;
      });

    const whole = await designInk();
    expect(whole).toBeGreaterThan(1000);

    // A folded shirt: the area is the same, but only its top half is on the
    // garment - so the design is cut at the fold instead of floating over it.
    await page.getByRole("button", { name: "Top half" }).click();
    await page.waitForTimeout(800);
    await expect(page.getByText("Top 50% of the area", { exact: true })).toBeVisible();
    const cropped = await designInk();
    // The design sits in the middle of the area: half of it is now hidden.
    expect(cropped).toBeLessThan(whole * 0.75);
    expect(cropped).toBeGreaterThan(whole * 0.2);

    // The window is part of the area, not a render-time trick.
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(/Print area saved/)).toBeVisible({ timeout: 30_000 });
    const stored = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const mockups: Array<{
        printArea?: { crop?: { x: number; y: number; width: number; height: number } };
      }> = await new Promise((res) => {
        const rq = db.transaction(["mockups"], "readonly").objectStore("mockups").getAll();
        rq.onsuccess = () => res(rq.result);
      });
      return mockups.find((m) => m.printArea)?.printArea?.crop;
    });
    expect(stored).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });

    // And it comes back after a reload.
    await gotoApp(page, "/mockups");
    await page.getByRole("button", { name: /^Print areas/ }).click();
    await expect(page.getByText("Top 50% of the area", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(1200);
    const reloaded = await designInk();
    expect(reloaded).toBeLessThan(whole * 0.75);
    expect(reloaded).toBeGreaterThan(whole * 0.2);

    // The window's handles crop it by hand. The bottom-centre handle of a
    // top-half window sits at the area's centre; drag it down and the window
    // grows, so more of the design is revealed.
    const geometry = await page.evaluate(() => {
      const el = document.querySelector("canvas") as HTMLCanvasElement;
      const wrapper = el.parentElement!.parentElement!;
      const r = wrapper.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width };
    });
    const state = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const mockups: Array<{
        width: number;
        height: number;
        printArea?: { frame: { x: number; y: number } };
      }> = await new Promise((res) => {
        const rq = db.transaction(["mockups"], "readonly").objectStore("mockups").getAll();
        rq.onsuccess = () => res(rq.result);
      });
      return mockups.find((m) => m.printArea)!;
    });
    const stageScale = geometry.width / state.width;
    const areaCx = geometry.left + state.printArea!.frame.x * state.width * stageScale;
    const areaCy = geometry.top + state.printArea!.frame.y * state.height * stageScale;

    await page.getByRole("button", { name: "Crop" }).click();
    await page.waitForTimeout(400);
    await page.mouse.move(areaCx, areaCy);
    await page.mouse.down();
    await page.mouse.move(areaCx, areaCy + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    await expect(page.getByText(/^Top \d+% of the area$/)).not.toHaveText(
      "Top 50% of the area",
      { timeout: 10_000 },
    );
    const widened = await designInk();
    expect(widened).toBeGreaterThan(reloaded * 1.05);
  });

  test("19. the studio's ink rows follow what the user ticks, not the product", async ({
    page,
  }) => {
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

  test("20. the studio says why a PAIRED design cannot print every ink colour", async ({
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
    await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({
      timeout: 30_000,
    });

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

  test("21. the hosted background-removal endpoint is gone", async ({ request }) => {
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
  // The Mockups library tab reads only the mockups table; the Print areas tab
  // (the one that reads the session) is not mounted yet.
  await page.goto("/mockups");
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({
    timeout: 30_000,
  });
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
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({
    timeout: 30_000,
  });
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

  // Designs live in the Printify Studio's Designs tab now.
  await gotoApp(page, "/printify-studio");
  await page.setInputFiles('input[type=file]', designFiles);
  // Wait until every uploaded design actually appears before navigating away.
  for (const name of designFiles.map((f) => path.basename(f, ".png"))) {
    await expect(
      page.getByRole("button", { name: `Actions for ${name}`, exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  }

  await gotoApp(page, "/mockups");
  await page.setInputFiles('input[type=file]', [fixture("mockup-a.png"), fixture("mockup-b.png")]);
  for (const name of ["mockup-a", "mockup-b"]) {
    await expect(
      page.getByRole("button", { name: `Actions for ${name}`, exact: true }),
    ).toBeVisible({ timeout: 30_000 });
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
