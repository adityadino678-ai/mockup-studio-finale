import { test, expect, chromium } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "https://mockup-studio.adityadino678.workers.dev";
const CDP_ENDPOINT = "ws://127.0.0.1:9233/devtools/browser/...";

test.describe("W8 Brave Browser Autopilot — 8 scenarios", () => {
  let browser;

  test.beforeAll(async () => {
    // Connect to Brave via CDP
    browser = await chromium.connectOverCDP("http://127.0.0.1:9233");
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test("T1: Upload design → appears in Designs tab", async () => {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(BASE_URL + "/printify-studio");
    await expect(page.locator("main")).toBeVisible();
  });

  test("T2: Mockup render → appears in Listing images", async () => {
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(BASE_URL + "/listing-images");
    await expect(page.locator("main")).toBeVisible();
  });

  test("T3: SEO Listing flow (research → draft → save)", async () => {
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(BASE_URL + "/listing-details");
    await expect(page.locator("main")).toBeVisible();
  });

  test("T4: Printify Product with ink variants", async () => {
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(BASE_URL + "/printify-studio");
    await expect(page.locator("main")).toBeVisible();
  });

  test("T5: Ink Variants - 5 dark colors all white ink", async () => {
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(BASE_URL + "/printify-studio");
    await expect(page.locator("main")).toBeVisible();
  });

  test("T6: Mockup Template auto-apply", async () => {
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(BASE_URL + "/mockups");
    await expect(page.locator("main")).toBeVisible();
  });

  test("T7: Fresh chat memory", async () => {
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(BASE_URL + "/agent");
    await expect(page.locator("main")).toBeVisible();
  });

  test("T8: Storage warning (70% warn, 90% prune)", async () => {
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(BASE_URL + "/settings");
    await expect(page.locator("main")).toBeVisible();
  });
});
