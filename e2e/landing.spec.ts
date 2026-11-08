import { test, expect } from "@playwright/test";

/**
 * The public landing page is the owner-supplied document at
 * `src/landing/exact.html`. These tests pin the visible contracts that must
 * not drift when that document is refreshed: anchors, calculator, live slogan
 * field, demo auth dialog, pricing placeholders, FAQ, finale, mobile layout,
 * and the product honesty rules. Behavioral behavior for the CSS-driven page
 * lives here; static source checks live in `tests/landing-content.test.ts`.
 */

test.describe("the root landing page", () => {
  test("renders the supplied title, hero and six steps", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle("ListBulkly – From sketch to shelf, in bulk");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "designs on Printify, in one sitting.",
    );
    await expect(
      page.getByRole("heading", { name: "What is listing by hand costing you?" }),
    ).toBeVisible();
    for (const part of ["Create", "Clean", "Mockup", "Describe", "Check", "Send"]) {
      await expect(page.getByRole("heading", { name: part, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Start free. Upgrade when your batches grow." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Questions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ship it" })).toBeVisible();
  });

  test("nav, hero and auth CTAs open the real sign-up dialog", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("nav")).toContainText("List/Bulkly");
    await expect(page.locator("nav a[href='#s1']")).toHaveText("How it works");
    await expect(page.locator("nav a[href='#pricing']")).toHaveText("Pricing");
    await expect(page.locator("nav a[href='#faq']")).toHaveText("FAQ");
    await expect(page.locator("nav a[data-auth='in']")).toHaveText("Log in");
    await expect(page.locator("nav a[data-auth='up']")).toHaveText("Start free");

    await page.locator("nav a[href='#pricing']").click();
    await expect(page).toHaveURL(/#pricing$/);
    await expect(page.locator("#pricing")).toContainText("Pro monthly");
    await expect(page.locator("#pricing")).toContainText("Pro yearly");

    const dialog = page.locator("#auth");
    await page.locator("nav a[data-auth='up']").click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#at")).toHaveText("Sign up");
    await expect(page.getByRole("button", { name: "Log in", exact: true }).last()).toBeVisible();

    // Stub the endpoint so the assertion checks the dialog's wiring, not a
    // live Supabase project's mail quota.
    await page.route("**/api/auth/signup", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          user: { id: "u_1", email: "seller@example.com" },
          needsEmailConfirmation: true,
          mode: "email-confirmation",
        }),
      }),
    );

    await page.locator("#em").fill("seller@example.com");
    await page.locator("#pw").fill("password123");
    await dialog.getByRole("button", { name: "Create account" }).click();
    await expect(dialog.locator("#am")).toContainText("check your email");
  });

  test("cost calculator updates week, year and work-week results", async ({ page }) => {
    await page.goto("/#cost");
    await expect(page.locator("#o1")).toHaveText("40");
    await expect(page.locator("#o2")).toHaveText("20");
    await expect(page.locator("#rh")).toHaveText("13.3");
    await expect(page.locator("#ry")).toHaveText("693");
    await expect(page.locator("#rw")).toHaveText("17.3");

    await page.locator("#r1").fill("100");
    await page.locator("#r2").fill("30");
    await expect(page.locator("#o1")).toHaveText("100");
    await expect(page.locator("#o2")).toHaveText("30");
    await expect(page.locator("#rh")).toHaveText("50");
    await expect(page.locator("#ry")).toHaveText("2,600");
    await expect(page.locator("#rw")).toHaveText("65");
  });

  test("all CTAs wired to the dialog and footer legal links reach the real pages", async ({ page }) => {
    await page.goto("/");
    for (const [label, mode] of [
      ["Get those hours back", "up"],
      ["Go Pro", "up"],
      ["Go Pro, yearly", "up"],
    ] as const) {
      const link = page.getByRole("link", { name: label, exact: true });
      await expect(link).toHaveAttribute("href", "#");
      await expect(link).toHaveAttribute("data-auth", mode);
    }

    for (const [label, href] of [
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
      ["Refunds", "/refunds"],
      ["Cookies", "/cookies"],
      ["Contact", "/contact"],
    ] as const) {
      await expect(
        page.locator(`footer a[href="${href}"]:has-text("${label}")`),
      ).toBeVisible();
    }
    await expect(page.locator("footer a")).toHaveCount(5);
    await expect(page.locator("footer small")).toContainText("Not affiliated with or endorsed by Printify or Etsy");
  });

  test("the live slogan field caps at 22 characters and splits into three tee lines", async ({
    page,
  }) => {
    await page.goto("/");
    const slogan = page.locator("#sl");
    await expect(slogan).toHaveValue("Make more merch");
    await expect(page.locator("#t1")).toHaveText("MAKE");
    await expect(page.locator("#t2")).toHaveText("MORE");
    await expect(page.locator("#t3")).toHaveText("MERCH");

    await slogan.fill("Good vibes only");
    await expect(page.locator("#t1")).toHaveText("GOOD");
    await expect(page.locator("#t2")).toHaveText("VIBES");
    await expect(page.locator("#t3")).toHaveText("ONLY");

    await slogan.fill("A very long slogan exceeding");
    await expect.poll(async () => await slogan.inputValue()).toHaveLength(22);
    await expect(page.locator("#t1")).toHaveText("A");
    await expect(page.locator("#t2")).toHaveText("VERY");
    await expect(page.locator("#t3")).toHaveText("LONG SLOGAN EXC");
  });

  test("pricing is explicitly a placeholder and the page states the no-auto-publish rule", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.locator("#pricing")).toContainText("PLACEHOLDER");
    await expect(page.locator("#pricing")).toContainText(
      "Prices and limits are placeholders. Set them in your plans config before launch.",
    );
    await expect(page.locator("#trust")).toContainText("Nothing goes live by itself");
    await expect(page.locator("#trust")).toContainText("Send stops at an unpublished draft");

    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/one-click publish/i);
    expect(text).not.toMatch(/trusted by|loved by|rated \d/i);
    expect(text).not.toMatch(/[\d,]+\s*(sellers|creators|customers|users)\b/i);
    expect(text).not.toMatch(/etsy\.com/i);
    expect(text).not.toMatch(/★|⭐/u);
  });

  test("a 390px phone has no horizontal overflow and no console errors", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("#sl")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
    await context.close();
  });
});

test.describe("onboarding", () => {
  test("Open Studio is a real link", async ({ page }) => {
    await page.goto("/onboarding");

    // The wizard is a client island. On a cold dev server the first click can
    // land before React hydrates and be ignored, so retry the gesture until
    // the done state is on screen instead of assuming the first one took.
    await expect(async () => {
      await page.getByRole("button", { name: "Skip all" }).click();
      await expect(
        page.getByRole("heading", { name: "Studio ready" }),
      ).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });

    await expect(page.locator('a[href="/printify-studio"]')).toBeVisible();
  });
});
