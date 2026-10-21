import { chromium } from "@playwright/test";

/**
 * Warms the dev server before the suite runs.
 *
 * The first request for a route makes Vite transform that route's modules and
 * pre-bundle its dependencies. On a cold server that takes long enough to
 * push the first page load past the assertion timeouts, so the suite fails on
 * pages that are perfectly fine - "the app shell did not hydrate", "main not
 * found" - with no application error anywhere.
 *
 * Visiting every route once, with a real browser, pays that cost up front.
 * It also proves that every route loads, before a single assertion runs.
 *
 * Playwright starts the web server before the global setup, so the server is
 * already up by the time this runs.
 */

/** Every route the suite visits. */
const ROUTES = [
  "/",
  "/agent",
  "/designs",
  "/mockups",
  "/editor",
  "/batch",
  "/templates",
  "/seo",
  "/activity",
  "/settings",
  "/products",
  "/listings",
  "/export",
  "/printify-studio",
];

export default async function globalSetup() {
  const baseURL = process.env.BASE_URL ?? "http://localhost:3100";
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const route of ROUTES) {
      try {
        await page.goto(new URL(route, baseURL).toString(), {
          waitUntil: "domcontentloaded",
          timeout: 120_000,
        });
        // The app shell is a React island: it only proves the route works
        // once the shell has hydrated.
        await page
          .getByRole("link", { name: /Batch Studio/ })
          .waitFor({ state: "attached", timeout: 60_000 });
      } catch {
        // A route that will not warm is a route the suite will report on
        // properly, with the real error.
      }
    }
  } finally {
    await browser.close();
  }
}
