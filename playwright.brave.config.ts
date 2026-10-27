import { defineConfig } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "https://mockup-studio.adityadino678.workers.dev";

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
    // Connect to Brave via CDP on port 9233
    connectOptions: {
      wsEndpoint: "http://127.0.0.1:9233",
    },
  },
  projects: [
    {
      name: "brave",
      use: {
        channel: "chrome", // Brave is Chrome-based
      },
    },
  ],
  // Don't manage a dev server when pointed at external target
  webServer: undefined,
});
