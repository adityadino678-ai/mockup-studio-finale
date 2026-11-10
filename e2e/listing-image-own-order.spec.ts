import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

/**
 * The per-design "Own order" toggle on Listing images.
 *
 * The shared order is the default state the numbered tests in workflow.spec.ts
 * already cover; this file only probes the DETACHED state, in its own file so
 * the numbered tests cannot shift. A row with Own order ON must keep seeding
 * and dragging strictly local, and turning it off on a differing order must
 * ask before discarding.
 */

const FIXTURES = path.join(process.cwd(), "e2e", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

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

async function gotoApp(page: Page, route: string) {
  await page.goto(route);
  await expect(page.getByRole("link", { name: "Printify Studio", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** The stored session row, read straight from IDB. */
async function readSession(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res) => {
      const r = indexedDB.open("mockup-studio");
      r.onsuccess = () => res(r.result);
    });
    const row = await new Promise<{ value?: Record<string, unknown> } | undefined>((res) => {
      const rq = db
        .transaction(["settings"], "readonly")
        .objectStore("settings")
        .get("printifyStudio:session");
      rq.onsuccess = () => res(rq.result);
    });
    return (row?.value ?? {}) as Record<string, unknown>;
  });
}

/**
 * Sets the Printify Studio's stored session directly.
 *
 * Same shape as workflow.spec.ts's helper: written from a page that cannot
 * save the session over it, and re-entered through the studio so the fresh
 * page loads what was written.
 */
async function setStudioSession(page: Page, patch: Record<string, unknown>) {
  await page.goto("/mockups");
  await expect(page.getByRole("link", { name: "Printify Studio", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(async (changes) => {
    const db: IDBDatabase = await new Promise((res) => {
      const r = indexedDB.open("mockup-studio");
      r.onsuccess = () => res(r.result);
    });
    const read = await new Promise<{ value?: Record<string, unknown> } | undefined>((res) => {
      const rq = db
        .transaction(["settings"], "readonly")
        .objectStore("settings")
        .get("printifyStudio:session");
      rq.onsuccess = () => res(rq.result);
    });
    const session = {
      inkRevision: 2,
      ...((read?.value ?? {}) as Record<string, unknown>),
      ...changes,
    };
    await new Promise<void>((res) => {
      const tx = db.transaction(["settings"], "readwrite");
      tx.objectStore("settings").put({ key: "printifyStudio:session", value: session });
      tx.oncomplete = () => res();
    });
  }, patch);
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: "Printify Studio", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("listing image own order", () => {
  test.beforeEach(async ({ page }) => {
    await clearWorkspace(page);
  });

  test("Own order detaches one row: seeding, dragging and turning it back off", async ({
    page,
  }) => {
    // Two designs and two product mockups, exactly like the shared-order test.
    await gotoApp(page, "/printify-studio");
    await page.setInputFiles("input[type=file]", [
      fixture("design-a.png"),
      fixture("design-b.png"),
    ]);
    for (const name of ["design-a", "design-b"]) {
      await expect(
        page.getByRole("button", { name: `Actions for ${name}`, exact: true }),
      ).toBeVisible({ timeout: 30_000 });
    }
    await gotoApp(page, "/mockups");
    await page.setInputFiles("input[type=file]", [
      fixture("mockup-a.png"),
      fixture("mockup-b.png"),
    ]);
    for (const name of ["mockup-a", "mockup-b"]) {
      await expect(
        page.getByRole("button", { name: `Actions for ${name}`, exact: true }),
      ).toBeVisible({ timeout: 30_000 });
    }
    const { designA, designB, mockupA, mockupB } = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res) => {
        const r = indexedDB.open("mockup-studio");
        r.onsuccess = () => res(r.result);
      });
      const readAll = (store: string) =>
        new Promise<Array<Record<string, unknown>>>((res) => {
          const rq = db.transaction([store], "readonly").objectStore(store).getAll();
          rq.onsuccess = () => res(rq.result as Array<Record<string, unknown>>);
        });
      const designs = await readAll("designs");
      const mockups = await readAll("mockups");
      const pick = (rows: Array<Record<string, unknown>>, name: string) => {
        const row = rows.find((r) => r.name === name);
        if (!row) throw new Error(`no ${name} row; have ${rows.map((r) => r.name).join(",")}`);
        return row.id as string;
      };
      return {
        designA: pick(designs, "design-a"),
        designB: pick(designs, "design-b"),
        mockupA: pick(mockups, "mockup-a"),
        mockupB: pick(mockups, "mockup-b"),
      };
    });

    // Shared order [B, A]: every row starts detached-OFF on that shared order.
    await setStudioSession(page, { designIds: [designA, designB], listingImageOrder: [mockupB, mockupA] });
    await gotoApp(page, "/listing-images");
    for (const design of [designA, designB]) {
      const row = page.locator(`[data-listing-id="${design}"]`);
      await expect(row.locator('[data-tile]').first()).toHaveAttribute("data-tile", mockupB, {
        timeout: 30_000,
      });
      await expect(row.getByRole("button", { name: "Own order" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }

    // Switch design A's row to its own order. The entry is seeded with the
    // order the row shows right now, so nothing may visibly move.
    const rowA = page.locator(`[data-listing-id="${designA}"]`);
    await rowA.getByRole("button", { name: "Own order" }).click();
    await expect(rowA.getByRole("button", { name: "Own order" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(rowA.locator('[data-tile]').first()).toHaveAttribute("data-tile", mockupB);
    await expect(rowA.locator("span").filter({ hasText: "Own order" })).toBeVisible(); // header badge
    // Design B stays on the shared order: its toggle is untouched.
    const rowB = page.locator(`[data-listing-id="${designB}"]`);
    await expect(rowB.getByRole("button", { name: "Own order" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // The stored session carries exactly one detached entry, holding the row's
    // visible order at the moment the toggle went on.
    const seeded = (await readSession(page)).listingImageOrders as
      | Record<string, string[]>
      | undefined;
    expect(seeded).toEqual({ [designA]: [mockupB, mockupA] });
    expect((await readSession(page)).listingImageOrder).toEqual([mockupB, mockupA]);

    // Drag design A's first tile behind the second one — framer-motion's
    // Reorder is pointer-driven, so this is a real mouse drag from the handle:
    // down on A's handle, over B's centre, release.
    const tileA = rowA.locator(`[data-tile="${mockupA}"]`);
    const tileB = rowA.locator(`[data-tile="${mockupB}"]`);
    const handleA = tileA.getByRole("button", { name: `Reorder mockup-a` });
    const handleBox = await handleA.boundingBox();
    const tileBBox = await tileB.boundingBox();
    if (!handleBox || !tileBBox) throw new Error("drag handles are not on screen");
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      tileBBox.x + tileBBox.width / 2,
      tileBBox.y + tileBBox.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    // A now stands where B stood: the row's first tile is A.
    await expect(rowA.locator('[data-tile]').first()).toHaveAttribute("data-tile", mockupA, {
      timeout: 15_000,
    });

    const afterDrag = (await readSession(page)).listingImageOrders as Record<string, string[]>;
    expect(afterDrag[designA]).toEqual([mockupA, mockupB]);
    // The shared order is untouched by a detached row's drag.
    expect((await readSession(page)).listingImageOrder).toEqual([mockupB, mockupA]);
    // Design B's row still shows the shared order.
    await expect(rowB.locator('[data-tile]').first()).toHaveAttribute("data-tile", mockupB);

    // Turning the own order OFF while it differs from the shared order asks
    // first; keeping it changes nothing.
    await rowA.getByRole("button", { name: "Own order" }).click();
    const dialog = page.getByRole("dialog", { name: /Discard .*own order/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep my order" }).click();
    await expect(dialog).toBeHidden();
    expect(((await readSession(page)).listingImageOrders as Record<string, string[]>)[designA]).toEqual([
      mockupA,
      mockupB,
    ]);

    // The second confirmation actually discards: the row returns to the
    // shared order and the entry is gone.
    await rowA.getByRole("button", { name: "Own order" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Switch to shared order" }).click();
    await expect(dialog).toBeHidden();
    await expect(rowA.locator('[data-tile]').first()).toHaveAttribute("data-tile", mockupB);
    expect((await readSession(page)).listingImageOrders).toEqual({});
  });
});
