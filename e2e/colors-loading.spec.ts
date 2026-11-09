import { test, expect, type Page } from "@playwright/test";

/**
 * The colour palette must not wait on the slow hex lookup.
 *
 * Colour NAMES come from the one-call variants endpoint. The real hexes come
 * from `colors=1`, which is three Printify round trips (shops, product list,
 * product detail) and was previously joined to the variants fetch with
 * `Promise.all`, so the palette stayed blank until the slowest of the two
 * finished. These tests pin the fix: the palette renders from variants alone,
 * and a warm browser serves variants/providers from IndexedDB with no network.
 */

const COLOURS = ["White", "Black", "Navy"];
const VARIANTS = COLOURS.flatMap((color, ci) =>
  ["S", "M", "L"].map((size, si) => ({
    id: 1000 + ci * 10 + si,
    title: `${color} / ${size}`,
    options: { color, size },
    available: true,
  })),
);

/**
 * Seed the Studio session (blueprint 6, provider 30) through IndexedDB.
 * Uses /mockups first so the database exists, and merges into whatever the
 * app already saved instead of replacing it.
 */
async function seedSession(page: Page) {
  await page.goto("/mockups");
  await expect(page.getByRole("link", { name: "Printify Studio", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(async () => {
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
    const session = {
      inkRevision: 2,
      ...((read?.value ?? {}) as Record<string, unknown>),
      blueprintId: 6,
      printProviderId: 30,
      updatedAt: Date.now(),
    };
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(["settings"], "readwrite");
      const rq = tx.objectStore("settings").put({ key: "printifyStudio:session", value: session });
      rq.onerror = () => rej(new Error("seed failed"));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(new Error("seed tx failed"));
    });
  });
}

async function stubCatalog(
  page: Page,
  opts: { delayColorsMs?: number; counts?: { variants: number; providers: number } } = {},
) {
  await page.route("**/api/printify/catalog*", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.searchParams.get("providers")) {
      if (opts.counts) opts.counts.providers += 1;
      body = { configured: true, providers: [{ id: 30, title: "Provider 30" }] };
    } else if (url.searchParams.has("colors")) {
      if (opts.delayColorsMs) {
        // Hold the hex lookup open: the palette must appear anyway.
        await new Promise((r) => setTimeout(r, opts.delayColorsMs));
      }
      body = {
        configured: true,
        source: "product",
        templateProductId: "p1",
        colors: COLOURS.map((title, i) => ({
          id: 100 + i,
          title,
          colors: ["#101010", "#202020", "#303030"],
        })),
        sizes: [],
        variants: [],
      };
    } else if (url.searchParams.has("provider")) {
      if (opts.counts) opts.counts.variants += 1;
      body = { configured: true, variants: VARIANTS };
    } else {
      body = {
        configured: true,
        blueprints: [{ id: 6, title: "T-Shirt", brand: "Gildan", model: "5000" }],
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function openColorsTab(page: Page) {
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: "Colors" }).click();
}

test.describe("colour palette loading", () => {
  test("the palette renders while the hex lookup is still pending", async ({ page }) => {
    await stubCatalog(page, { delayColorsMs: 15_000 });
    await seedSession(page);
    await openColorsTab(page);

    // With the old Promise.all join these swatches only appeared after the
    // 15 s hex lookup. They must appear as soon as the variants land. Both
    // rows render each colour, so scope to the first (plain) panel.
    await expect(page.locator('button[data-colour="White"]').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('button[data-colour="Black"]').first()).toBeVisible();
    await expect(page.locator('button[data-colour="Navy"]').first()).toBeVisible();
  });

  test("a warm browser serves variants and providers without network", async ({ page }) => {
    const counts = { variants: 0, providers: 0 };
    await stubCatalog(page, { counts });
    await seedSession(page);
    await openColorsTab(page);
    await expect(page.locator('button[data-colour="White"]').first()).toBeVisible({
      timeout: 30_000,
    });
    expect(counts.variants).toBeGreaterThan(0);
    expect(counts.providers).toBeGreaterThan(0);

    // Same browser, new page load: IndexedDB still holds the catalogue, so
    // neither endpoint is called again.
    const before = { ...counts };
    await openColorsTab(page);
    await expect(page.locator('button[data-colour="White"]').first()).toBeVisible({
      timeout: 10_000,
    });
    expect(counts.variants).toBe(before.variants);
    expect(counts.providers).toBe(before.providers);
  });
});
