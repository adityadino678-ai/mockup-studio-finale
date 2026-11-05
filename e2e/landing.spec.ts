import { test, expect } from "@playwright/test";

/**
 * The landing/auth pages are gone: `/` is a static redirect to `/printify-studio`
 * (meta refresh plus location.replace), and the sign-in/sign-up flow was
 * removed. These tests pin the contract the migration actually shipped.
 */

test.describe("the root page", () => {
  test("redirects to the Studio", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/printify-studio\/?$/, { timeout: 15_000 });
  });
});

test.describe("onboarding", () => {
  test("Open Studio is a real link", async ({ page }) => {
    await page.goto("/onboarding");
    // Click "Skip all" to reach the done state where Open Studio shows.
    await page.getByRole("button", { name: "Skip all" }).click();
    await expect(page.getByRole("heading", { name: "Studio ready" })).toBeVisible();
    await expect(page.locator('a[href="/printify-studio"]')).toBeVisible();
  });
});
