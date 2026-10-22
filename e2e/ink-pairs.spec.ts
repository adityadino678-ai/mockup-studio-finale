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
  await page.goto("/");
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const database of databases) {
      if (database.name) indexedDB.deleteDatabase(database.name);
    }
  });
  await page.reload();
}

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test("two designs can be paired as one listing, with a black-ink and a white-ink half", async ({
  page,
}) => {
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: /Batch Studio/ })).toBeVisible({ timeout: 30_000 });

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

test("the adjustment preview clips the artwork to the print area", async ({ page }) => {
  await page.goto("/printify-studio");
  await expect(page.getByRole("link", { name: /Batch Studio/ })).toBeVisible({ timeout: 30_000 });
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
