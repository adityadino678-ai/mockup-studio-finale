import { expect, test } from "@playwright/test";

/**
 * Phase 1 design-system guards. The existing app suite lives in workflow.spec.ts;
 * these tests only cover the sketchbook catalogue page.
 */

test("the styleguide renders with no console errors and a visible nav CTA", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/styleguide");
  await expect(page.getByRole("heading", { name: "Design system" })).toBeVisible();

  const cta = page.locator(".sk-nav .sk-btn");
  await expect(cta).toHaveText("Start free");
  // Regression: a base `a` rule once made the label ink-on-ink.
  await expect(cta).toHaveCSS("color", "rgb(247, 243, 236)");

  await expect(page.locator(".sk-swatch__chip")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("the hero tee draws itself when the scene enters the viewport", async ({
  page,
}) => {
  await page.goto("/styleguide");
  const scene = page.locator("#tee .sk-scene");
  await scene.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(scene).toHaveClass(/sk-in/);

  const fill = scene.locator(".sk-tee path.sk-f").first();
  await expect(fill).toHaveCSS("opacity", "1", { timeout: 10_000 });
  await expect(scene.locator(".sk-tee text").nth(1)).toHaveText("MORE");
});

test("reduced motion shows every stroke without arming a scene", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/styleguide");

  await expect(page.locator(".sk-anim")).toHaveCount(0);
  await expect(page.locator(".sk-f").first()).toHaveCSS("opacity", "1");
  await expect(page.locator("path.sk-d").first()).toHaveCSS(
    "stroke-dashoffset",
    "0px",
  );
  await expect(page.locator(".sk-mq__track")).toHaveCSS("animation-name", "none");
  await context.close();
});

test("the dialog opens, traps focus and closes on Escape; toasts report status", async ({
  page,
}) => {
  await page.goto("/styleguide");
  // .sk-anim / .sk-in are added by a React effect, so this waits for hydration
  // instead of racing the click against a cold Vite chunk.
  await expect(page.locator(".sk-scene").first()).toHaveClass(/sk-(anim|in)/);
  await page.getByRole("button", { name: "Open the dialog" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Email")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  await page.getByRole("button", { name: "Success toast" }).click();
  await expect(page.locator(".sk-toasts")).toContainText(
    "Render saved to this listing.",
  );
});

test("a 390px phone has no horizontal overflow", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto("/styleguide");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await context.close();
});
