import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

/**
 * DESIGN pairs: two designs on ONE product, the older on the FRONT print
 * area, the newer on the BACK, both on the "No ink variants" colours.
 * Completely separate from ink pairs in every way.
 *
 * The defining gesture is INSTANT: ticking the "Design pair" checkbox on a
 * second design pairs the two right then - no button press needed. The
 * selection bar's pair buttons were removed on the owner's instruction: the
 * checkboxes carry the pairing gestures entirely.
 */

const fixture = (name: string) => path.join(process.cwd(), "e2e", "fixtures", name);

async function resetWorkspace(page: Page) {
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

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test("ticking Design pair on two cards pairs them instantly, front + back", async ({ page }) => {
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: "Printify Studio" })).toBeVisible({
    timeout: 30_000,
  });

  // design-a uploads first, so it is the OLDER design: it takes the FRONT.
  await page.setInputFiles("input[type=file]", [fixture("design-a.png"), fixture("design-b.png")]);
  await expect(page.getByText("No ink variants (2)")).toBeVisible({ timeout: 30_000 });

  // The user's gesture: tick "Design pair" on both cards. The second tick
  // pairs the two immediately - the cards answer at once, no button.
  await page.getByRole("checkbox", { name: "Design pair for design-a" }).click();
  await expect(page.locator("[data-design-pair-role]")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Design pair for design-b" }).click();
  await expect(page.locator("[data-design-pair-role]")).toHaveCount(2);

  // design-a (older) is the front half, design-b the back half.
  await expect(page.getByRole("checkbox", { name: "design-a prints on the front" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "design-b prints on the back" })).toBeChecked();
  await expect(page.getByText(/Paired with “design-b”/)).toBeVisible();
  await expect(page.getByText(/Paired with “design-a”/)).toBeVisible();

  // The pair lives in the session, so a reload cannot invent a different one.
  await page.waitForTimeout(900);
  await page.reload();
  await expect(page.getByText("No ink variants (2)")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("checkbox", { name: "design-a prints on the front" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "design-b prints on the back" })).toBeChecked();

  // Unticking one half breaks the pair: both designs print on their own again.
  await page.getByRole("checkbox", { name: "Design pair for design-a" }).click();
  await expect(page.locator("[data-design-pair-role]")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Design pair for design-a" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Design pair for design-b" })).not.toBeChecked();
});
