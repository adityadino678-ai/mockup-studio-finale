import { expect, test } from "@playwright/test";

/**
 * The public pages that sit outside the sidebar shell: the five legal drafts
 * and the two optional account screens. They are easy to break because no
 * workflow test walks through them.
 *
 * The last element is the page's HONESTY MARKER. Unknown legal facts (entity,
 * jurisdiction, price) stay marked PLACEHOLDER; a page whose only unknown fact
 * is the entity says so in its own words, and /contact is allowed to point at
 * the real inbox instead. The point is that a page cannot quietly become
 * "final" while a fact is still missing.
 */

const LEGAL = [
  ["/privacy", "Privacy", "PLACEHOLDER"],
  ["/terms", "Terms", "PLACEHOLDER"],
  ["/refunds", "Refunds", "PLACEHOLDER"],
  ["/cookies", "Cookies", "Draft"],
  ["/contact", "Contact", "not published yet"],
] as const;

test.describe("public legal pages", () => {
  for (const [href, heading, marker] of LEGAL) {
    test(`${href} loads with its heading`, async ({ page }) => {
      const res = await page.goto(href);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      // Honesty rule: unknown legal/billing facts are marked, never invented.
      await expect(page.getByText(marker).first()).toBeVisible();
    });
  }

  test("/contact publishes the real inbox", async ({ page }) => {
    await page.goto("/contact");
    await expect(
      page.locator('a[href="mailto:listbulkly@gmail.com"]').first(),
    ).toBeVisible();
  });
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
