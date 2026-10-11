import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The .next wipe works around OneDrive placeholder files (EINVAL readlink)
    // when the project folder lives inside a synced OneDrive directory.
    command:
      process.platform === "win32"
        ? "rd /s /q .next 2>nul & npm run dev -- --port 3100"
        : "rm -rf .next && npm run dev -- --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});