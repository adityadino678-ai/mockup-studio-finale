import { test, expect } from "@playwright/test";

/**
 * Landing page acceptance coverage: every CTA is a real anchor that loads a
 * real page.
 *
 * Follows the style of workflow.spec.ts: plain imports, no beforeEach
 * clearing (landing pages read no IndexedDB), each test navigates itself.
 */

test.describe("landing page", () => {
  test("landing hero CTA is a real link to /auth/signup", async ({ page }) => {
    await page.goto("/");
    const heroStart = page.locator('#hero a[href="/auth/signup"]');
    await expect(heroStart).toBeVisible();
    await expect(heroStart).toHaveText(/Start Free/);
  });

  test("hero Start Free navigates to the signup page", async ({ page }) => {
    await page.goto("/");
    await page.locator('#hero a[href="/auth/signup"]').click();
    await expect(page).toHaveURL(/\/auth\/signup/);
    await expect(page.locator("#signup-form")).toBeVisible();
  });

  test("See how it works anchors to the how section", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('a[href="#how"]')).toBeVisible();
    await expect(page.locator("#how")).toBeVisible();
  });

  test("header Sign in link navigates", async ({ page }) => {
    await page.goto("/");
    await page.locator('header a[href="/auth/signin"]').click();
    await expect(page).toHaveURL(/\/auth\/signin/);
    await expect(page.locator("#signin-form")).toBeVisible();
  });

  test("auth pages cross-link and link home", async ({ page }) => {
    await page.goto("/auth/signin");
    await expect(page.locator('a[href="/auth/signup"]')).toBeVisible();
    await expect(page.locator('a[href="/"]').first()).toBeVisible();

    await page.goto("/auth/signup");
    await expect(page.locator('a[href="/auth/signin"]')).toBeVisible();
    await expect(page.locator('a[href="/"]').first()).toBeVisible();
  });

  test("onboarding Open Studio is a real link", async ({ page }) => {
    await page.goto("/onboarding");
    // Click "Skip all" to reach the done state where Open Studio shows.
    await page.getByRole("button", { name: "Skip all" }).click();
    await expect(page.getByRole("heading", { name: "Studio ready" })).toBeVisible();
    await expect(page.locator('a[href="/printify-studio"]')).toBeVisible();
  });
});
