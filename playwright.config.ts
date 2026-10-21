import { defineConfig, devices } from "@playwright/test";

/**
 * By default the suite boots its own dev server on port 3100.
 * Set BASE_URL to run against an already-running target instead - for example
 * the deployed Worker, which is what CI does:
 *
 *   $env:BASE_URL = "https://mockup-studio.adityadino678.workers.dev"
 *   npx playwright test
 */
const baseURL = process.env.BASE_URL ?? "http://localhost:3100";
const external = Boolean(process.env.BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The dev server pays a large one-off cost on the first request for a
  // route, and that cost used to land inside a test's assertion timeout.
  globalSetup: "./e2e/global-setup.ts",
  // Only manage a dev server when we are not pointed at an external target.
  webServer: external
    ? undefined
    : {
        command: "npm run dev -- --port 3100",
        url: "http://localhost:3100",
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
