import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

/**
 * Pairing two uploaded designs as ONE Printify listing, and the clipping of
 * the adjustment preview.
 *
 * Kept in its own file so the workflow numbers in `workflow.spec.ts` do not
 * shift: that suite is long, and renumbering it would break every reference
 * to "test 22" in the project notes.
 */

const fixture = (name: string) => path.join(process.cwd(), "e2e", "fixtures", name);

async function resetWorkspace(page: Page) {
  // Land on the app first: the CDP call needs the page's origin, and "/" is a
  // redirect to the Studio now. Clearing through CDP also avoids the blocked
  // `deleteDatabase` request the page's own open Dexie connection would hold.
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
 * Patch the stored Studio session through IndexedDB, from a page that does
 * NOT read it, so nothing can save over the seeded value before the Studio
 * loads it. Mirrors the helper in `workflow.spec.ts`.
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
    // Seeds are EXPLICIT-model sessions unless a test opts into legacy data by
    // setting `inkRevision` itself; otherwise a seed with no inkRevision would
    // be treated as the old automatic split and cleared on load.
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

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

/**
 * Stub the four `/api/printify/catalog` shapes the Studio calls.
 *
 * Without a valid Printify key the real endpoint answers 503 and the page
 * flips `configured` to false, which swaps the whole Colors tab for a
 * "Printify is not connected" card. The ink split readout lives in those
 * panels, so the test must keep the catalogue configured and hand back the
 * three colours its session seeds (White, Black, Navy). Installed before the
 * first navigation so `configured` never flips.
 */
async function mockCatalog(page: Page) {
  const colours = ["White", "Black", "Navy"];
  const variants = colours.flatMap((color, ci) =>
    ["S", "M", "L"].map((size, si) => ({
      id: 1000 + ci * 10 + si,
      title: `${color} / ${size}`,
      options: { color, size },
      available: true,
    })),
  );

  await page.route("**/api/printify/catalog*", async (route) => {
    const url = new URL(route.request().url());
    const body = url.searchParams.get("providers")
      ? { configured: true, providers: [{ id: 30, title: "Provider 30" }] }
      : url.searchParams.has("colors")
        ? { configured: true, source: "none", colors: [], sizes: [], variants: [] }
        : url.searchParams.has("provider")
          ? { configured: true, variants }
          : {
              configured: true,
              blueprints: [{ id: 6, title: "T-Shirt", brand: "Gildan", model: "5000" }],
            };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test("two designs can be paired as one listing, with a black-ink and a white-ink half", async ({
  page,
}) => {
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({ timeout: 30_000 });

  await page.setInputFiles("input[type=file]", [fixture("design-a.png"), fixture("design-b.png")]);
  await expect(page.getByText("No ink variants (2)")).toBeVisible({ timeout: 30_000 });

  // The user's own gesture: tick "Ink variants" on the two designs, then the
  // ink row offers to pair them. No batch checkbox is involved.
  await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
  await page.getByRole("checkbox", { name: "Ink variants for design-b" }).click();
  await expect(page.getByText("Has ink variants (2)")).toBeVisible();

  const pairInk = page.getByRole("button", { name: /Pair these two as one listing/ });
  await expect(pairInk).toBeVisible();
  await pairInk.click();

  await expect(page.getByRole("checkbox", { name: "design-a prints black ink" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "design-b prints white ink" })).toBeChecked();
  // Both cards name their partner, so the two halves describe the same pair.
  await expect(page.locator("[data-ink-pair-role]")).toHaveCount(2);

  // The roles are swappable on the cards.
  await page.getByRole("checkbox", { name: "design-b prints black ink" }).click();
  await expect(page.getByRole("checkbox", { name: "design-b prints black ink" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "design-a prints white ink" })).toBeChecked();

  // The pair lives in the session, so a reload cannot invent a different one.
  await page.waitForTimeout(900);
  await page.reload();
  await expect(page.getByText("Has ink variants (2)")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("checkbox", { name: "design-b prints black ink" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "design-a prints white ink" })).toBeChecked();

  // The role UI must not push a card out of its row.
  const layout = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("[data-design-card]"));
    const bad: string[] = [];
    for (const card of cards) {
      const row = card.closest("[data-design-row]");
      if (!row) {
        bad.push("card outside a row");
        continue;
      }
      const cardRect = card.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (cardRect.left < rowRect.left - 1 || cardRect.right > rowRect.right + 1) {
        bad.push(card.getAttribute("data-design-card") ?? "unknown");
      }
    }
    return { cards: cards.length, bad };
  });
  expect(layout.cards).toBeGreaterThan(0);
  expect(layout.bad).toEqual([]);

  // Unpair breaks it and returns both designs to the no-ink row.
  await page.getByRole("button", { name: "Unpair" }).first().click();
  await expect(page.getByText("No ink variants (2)")).toBeVisible();
  await expect(page.locator("[data-ink-pair-role]")).toHaveCount(0);

  // The batch checkboxes still pair a specific two - both halves are already
  // in the scope, so the bar's button is the path that stays open.
  await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
  await page.getByRole("checkbox", { name: "Ink variants for design-b" }).click();
  await expect(page.getByText("Has ink variants (2)")).toBeVisible();
  await page.getByRole("button", { name: /Pair for one listing/ }).click();
  await expect(page.locator("[data-ink-pair-role]")).toHaveCount(2);
});

test("the ink split readout changes when a colour's ink chip is flipped", async ({ page }) => {
  await mockCatalog(page);
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({ timeout: 30_000 });
  await page.setInputFiles("input[type=file]", [fixture("design-a.png")]);
  await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 30_000 });

  // Tick the design into the ink row so the ink panel applies to it.
  await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
  await expect(page.getByText("Has ink variants (1)")).toBeVisible();

  // Seed the ink panel directly: one black-ink colour, one white-ink colour.
  // The readout is derived from this state, so a chip flip must move a colour
  // between the two halves.
  await setStudioSession(page, {
    blueprintId: 6,
    printProviderId: 30,
    rows: {
      plain: { colors: ["White"], blackInkColors: [] },
      ink: { colors: ["Black", "Navy"], blackInkColors: ["Black"] },
    },
  });
  await page.getByRole("tab", { name: "Colors" }).click();

  const readout = page.getByText(/Black ink: .* White ink:/);
  await expect(readout).toContainText("Black ink: 1 colour (Black)");
  await expect(readout).toContainText("White ink: 1 colour (Navy)");

  // Flip Navy to black ink: the split must follow, not stay stale.
  await page.getByRole("button", { name: "Navy: print with black ink" }).click();
  await expect(readout).toContainText("Black ink: 2 colours (Black and Navy)");
  await expect(readout).toContainText("White ink: 0 colours");

  // And back to white ink, so the readout tracks the chip both ways.
  await page.getByRole("button", { name: "Navy: print with white ink" }).click();
  await expect(readout).toContainText("Black ink: 1 colour (Black)");
  await expect(readout).toContainText("White ink: 1 colour (Navy)");
});

test("a colour with no ink choice prints on nothing and blocks Create", async ({ page }) => {
  await mockCatalog(page);
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({ timeout: 30_000 });

  // Navy is in the ink panel with NO ink choice, so it must not be guessed onto
  // either design. An explicit empty white list is what marks it undecided -
  // an absent one is a legacy session and is migrated to implicit white.
  await setStudioSession(page, {
    blueprintId: 6,
    printProviderId: 30,
    rows: {
      plain: { colors: [], blackInkColors: [], whiteInkColors: [] },
      ink: { colors: ["Black", "Navy"], blackInkColors: ["Black"], whiteInkColors: [] },
    },
  });

  await page.setInputFiles("input[type=file]", [fixture("design-a.png")]);
  await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: "Ink variants for design-a" }).click();
  await expect(page.getByText("Has ink variants (1)")).toBeVisible();
  // A tick alone is not batch scope: tick the design's own checkbox too.
  await page.getByRole("checkbox", { name: "Select design-a" }).click();

  // The readout names the undecided colour and says what it means.
  await page.getByRole("tab", { name: "Colors" }).click();
  const readout = page.getByText(/Black ink: .* White ink:/);
  await expect(readout).toContainText("Black ink: 1 colour (Black)");
  await expect(readout).toContainText("White ink: 0 colours");
  await expect(page.getByText(/undecided/i)).toContainText("Navy");
  await expect(page.getByText(/undecided/i)).toContainText("block Create");

  // Create really refuses: the dialog opens, confirming sends nothing, and
  // the reason is the same one the Colors tab named.
  await page.getByRole("tab", { name: "Design panel" }).click();
  let productRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/printify/products")) {
      productRequests += 1;
    }
  });
  await page.getByRole("button", { name: /Create on Printify/ }).click();
  await page.getByRole("button", { name: "Create drafts" }).click();
  await expect(page.getByText("Fix the problems above before creating the listings.")).toBeVisible();
  expect(productRequests).toBe(0);
});

test("a legacy automatic split is cleared once and leaves the plain row untouched", async ({
  page,
}) => {
  await mockCatalog(page);
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({ timeout: 30_000 });

  // The OLD app's data: no explicit white, and the black list is the light/dark
  // GUESS ("light garments get black ink"). `inkRevision: 1` marks it legacy.
  await setStudioSession(page, {
    inkRevision: 1,
    blueprintId: 6,
    printProviderId: 30,
    rows: {
      plain: { colors: ["White"], blackInkColors: [] },
      ink: {
        colors: ["Black", "Navy", "White"],
        blackInkColors: ["White", "Navy"],
      },
    },
  });

  await page.getByRole("tab", { name: "Colors" }).click();

  // The guess is gone, and the user is told why. Nothing was silently moved to
  // the other design.
  const notice = page.locator("[data-ink-reset]");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("only your Black ink / White ink marks decide");
  const routes = page.locator("[data-ink-route]");
  await expect(routes).toHaveCount(3);
  for (const name of ["Black", "Navy", "White"]) {
    await expect(page.locator(`[data-ink-route="${name}"]`)).toHaveAttribute(
      "data-ink-route-to",
      "none",
    );
  }
  // The no-ink row keeps the user's colours: only the ink guess was cleared.
  await expect(page.getByText(/No ink variants row →/)).toContainText("1 colour (White)");

  // Dismiss first so the reset cannot run again, then make an explicit choice.
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator("[data-ink-reset]")).toHaveCount(0);
  await page.getByRole("button", { name: "Navy: print with black ink" }).click();
  await expect(page.locator('[data-ink-route="Navy"]')).toHaveAttribute(
    "data-ink-route-to",
    "black",
  );
  await expect(page.locator('[data-ink-route="Navy"]')).toContainText("Black-ink design");
  await expect(page.locator('[data-ink-route="Black"]')).toHaveAttribute(
    "data-ink-route-to",
    "none",
  );

  // The explicit choice survives a reload, and the reset never fires again.
  await page.waitForTimeout(900);
  await page.reload();
  await page.getByRole("tab", { name: "Colors" }).click();
  await expect(page.locator("[data-ink-reset]")).toHaveCount(0);
  await expect(page.locator('[data-ink-route="Navy"]')).toHaveAttribute(
    "data-ink-route-to",
    "black",
  );
  await expect(page.locator('[data-ink-route="Black"]')).toHaveAttribute(
    "data-ink-route-to",
    "none",
  );

  // And "Clear all ink marks" only clears the ink row.
  await page.getByRole("button", { name: "Clear all ink marks" }).click();
  await expect(page.locator('[data-ink-route="Navy"]')).toHaveAttribute(
    "data-ink-route-to",
    "none",
  );
  await expect(page.getByText(/No ink variants row →/)).toContainText("1 colour (White)");
});

test("the adjustment preview clips the artwork to the print area", async ({ page }) => {
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({ timeout: 30_000 });
  await page.setInputFiles("input[type=file]", [fixture("design-a.png")]);
  await expect(page.getByText("No ink variants (1)")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("tab", { name: "Design panel" }).click();
  await page.getByRole("button", { name: "Open design-a" }).click();
  await expect(page.locator("#studio-scale")).toBeVisible({ timeout: 30_000 });

  // 200% of the area is twice the frame, so the artwork is taller and wider
  // than the preview - the case that used to paint over the controls.
  await page.locator("#studio-scale").fill("200");
  await page.locator("#studio-scale").press("Enter");
  await page.waitForTimeout(400);

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector("[data-design-panel]");
    const preview = panel?.querySelector('[role="img"]') ?? null;
    const art = preview?.querySelector("[data-artwork]") ?? null;
    if (!preview || !art) return null;
    const clip = art.parentElement;
    const previewRect = preview.getBoundingClientRect();
    const artRect = art.getBoundingClientRect();
    return {
      clipX: clip ? getComputedStyle(clip).overflowX : "",
      clipY: clip ? getComputedStyle(clip).overflowY : "",
      // The artwork is genuinely larger than its frame...
      artWider: artRect.width > previewRect.width + 1,
      artTaller: artRect.height > previewRect.height + 1,
    };
  });
  expect(geometry).not.toBeNull();
  // ...and the frame is what limits it.
  expect(geometry!.clipX).toBe("hidden");
  expect(geometry!.clipY).toBe("hidden");
  expect(geometry!.artWider).toBe(true);
  expect(geometry!.artTaller).toBe(true);

  // The rotation handle is clamped inside the preview, so it can never land
  // on the sliders or outside the dialog.
  const preview = page.locator("[data-design-panel] [role=img]");
  const previewBox = await preview.boundingBox();
  const handleBox = await page.locator("[data-design-panel] [data-rotate-handle]").boundingBox();
  expect(previewBox).not.toBeNull();
  expect(handleBox).not.toBeNull();
  expect(handleBox!.x).toBeGreaterThanOrEqual(previewBox!.x - 1);
  expect(handleBox!.y).toBeGreaterThanOrEqual(previewBox!.y - 1);
  expect(handleBox!.x + handleBox!.width).toBeLessThanOrEqual(
    previewBox!.x + previewBox!.width + 1,
  );
  expect(handleBox!.y + handleBox!.height).toBeLessThanOrEqual(
    previewBox!.y + previewBox!.height + 1,
  );
});
