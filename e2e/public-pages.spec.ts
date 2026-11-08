import { expect, test } from "@playwright/test";

/**
 * The public pages that sit outside the sidebar shell: the five legal drafts
 * and the two optional account screens. They are easy to break because no
 * workflow test walks through them.
 */

const LEGAL = [
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
  ["/refunds", "Refunds"],
  ["/cookies", "Cookies"],
  ["/contact", "Contact"],
] as const;

test.describe("public legal pages", () => {
  for (const [href, heading] of LEGAL) {
    test(`${href} loads with its heading`, async ({ page }) => {
      const res = await page.goto(href);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      // Honesty rule: unknown legal/billing facts are marked, never invented.
      await expect(page.getByText("PLACEHOLDER").first()).toBeVisible();
    });
  }
});

test.describe("account screens", () => {
  test("/login offers the email form or says accounts are unavailable", async ({ page }) => {
    const res = await page.goto("/login");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Log in");

    // Exactly one is shown after /api/auth/status resolves; the other stays
    // hidden in the DOM, so assert on the visible union, not both elements.
    await expect(
      page.locator("#auth-form:visible").or(page.locator("#auth-unavailable:visible")),
    ).toBeVisible();
  });

  test("/auth/confirm explains a link that carries no token", async ({ page }) => {
    const res = await page.goto("/auth/confirm");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Confirm your email");
    await expect(page.locator("#confirm-text")).toContainText("no confirmation token");
  });
});
