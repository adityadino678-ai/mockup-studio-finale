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
  test("/login is gone — the landing dialog is the only account surface", async ({ page }) => {
    const res = await page.goto("/login");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
  });

  test("/auth/confirm explains a link that carries no token", async ({ page }) => {
    const res = await page.goto("/auth/confirm");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Confirm your email");
    await expect(page.locator("#confirm-text")).toContainText("no confirmation token");
  });

  const STUDIO = /\/printify-studio\/?$/;

  async function stubStudio(page: import("@playwright/test").Page) {
    await page.route(STUDIO, (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Studio</h1>" }),
    );
  }

  test("Start free opens the small window with a name field", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#auth")).toBeHidden();

    await page.getByRole("link", { name: "Start free" }).first().click();

    await expect(page.locator("#auth")).toBeVisible();
    await expect(page.locator("#at")).toHaveText("Sign up");
    await expect(page.locator("#nmrow")).toBeVisible();
    await expect(page.locator("#nm")).toBeVisible();

    // The name belongs to account creation only: switching to log-in hides it.
    await page.click('.seg button[data-m="in"]');
    await expect(page.locator("#at")).toHaveText("Log in");
    await expect(page.locator("#nmrow")).toBeHidden();
  });

  test("/?auth=in opens the same window in log-in mode", async ({ page }) => {
    await page.goto("/?auth=in");
    await expect(page.locator("#auth")).toBeVisible();
    await expect(page.locator("#at")).toHaveText("Log in");
    await expect(page.locator("#nmrow")).toBeHidden();
  });

  test("signing up sends the name and lands on the Studio", async ({ page }) => {
    let posted: Record<string, unknown> | null = null;
    await page.route("**/api/auth/signup", async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        json: {
          ok: true,
          mode: "instant",
          needsEmailConfirmation: false,
          user: { id: "u1", email: "seller@example.test" },
          accessToken: "token-from-signup",
          refreshToken: "refresh",
          expiresAt: 1,
        },
      });
    });
    await stubStudio(page);

    await page.goto("/?auth=up");
    await page.fill("#nm", "Asha Seller");
    await page.fill("#em", "seller@example.test");
    await page.fill("#pw", "password123");
    await page.click("#ab");

    await page.waitForURL(STUDIO, { timeout: 15000 });
    expect(posted).toMatchObject({
      email: "seller@example.test",
      fullName: "Asha Seller",
    });
    expect(
      await page.evaluate(() => localStorage.getItem("mockup-studio:auth-token")),
    ).toBe("token-from-signup");
  });

  test("logging in from the window lands on the Studio", async ({ page }) => {
    let posted: Record<string, unknown> | null = null;
    await page.route("**/api/auth/signin", async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        json: {
          ok: true,
          mode: "instant",
          needsEmailConfirmation: false,
          user: { id: "u1", email: "seller@example.test" },
          accessToken: "token-from-signin",
          refreshToken: "refresh",
          expiresAt: 1,
        },
      });
    });
    await stubStudio(page);

    await page.goto("/?auth=in");
    await page.fill("#em", "seller@example.test");
    await page.fill("#pw", "password123");
    await page.click("#ab");

    await page.waitForURL(STUDIO, { timeout: 15000 });
    expect(posted).toMatchObject({ email: "seller@example.test" });
    expect(posted).not.toHaveProperty("fullName");
    expect(
      await page.evaluate(() => localStorage.getItem("mockup-studio:auth-token")),
    ).toBe("token-from-signin");
  });
});
