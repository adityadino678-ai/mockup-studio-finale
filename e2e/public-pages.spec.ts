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

  // /login is an entry point, not a destination: a related bug sent a
  // successfully signed-in visitor to /login, where the page showed "Signed in
  // as …" and left them there. The Studio must load instead.
  const STUDIO = /\/printify-studio\/?$/;

  async function stubStudio(page: import("@playwright/test").Page) {
    await page.route(STUDIO, (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Studio</h1>" }),
    );
  }

  test("a visitor who already has a session is sent to the Studio", async ({ page }) => {
    await page.route("**/api/auth/status", (route) =>
      route.fulfill({ json: { configured: true, serviceRole: true, signupMode: "instant" } }),
    );
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ json: { user: { id: "u1", email: "seller@example.test" } } }),
    );
    await stubStudio(page);
    await page.addInitScript(() =>
      localStorage.setItem("mockup-studio:auth-token", "test-token"),
    );

    await page.goto("/login");
    await page.waitForURL(STUDIO, { timeout: 15000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Studio");
  });

  test("logging in goes straight to the Studio and keeps the token", async ({ page }) => {
    await page.route("**/api/auth/status", (route) =>
      route.fulfill({ json: { configured: true, serviceRole: true, signupMode: "instant" } }),
    );
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 401, json: { error: "unauthorized" } }),
    );
    await page.route("**/api/auth/signin", (route) =>
      route.fulfill({
        json: {
          ok: true,
          mode: "instant",
          needsEmailConfirmation: false,
          user: { id: "u1", email: "seller@example.test" },
          accessToken: "token-from-signin",
          refreshToken: "refresh",
          expiresAt: 1,
        },
      }),
    );
    await stubStudio(page);

    await page.goto("/login");
    await page.fill("#auth-email-input", "seller@example.test");
    await page.fill("#auth-password-input", "password123");
    await page.click("#auth-submit");

    await page.waitForURL(STUDIO, { timeout: 15000 });
    expect(
      await page.evaluate(() => localStorage.getItem("mockup-studio:auth-token")),
    ).toBe("token-from-signin");
  });
});
