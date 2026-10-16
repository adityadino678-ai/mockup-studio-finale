import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    css: false,
    // The default forks pool does not start reliably in this environment;
    // threads run the same tests in-process.
    pool: "threads",
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // `astro:env/server` is a virtual module provided by the Astro runtime.
      // Point it at a plain stub so server modules are unit-testable.
      "astro:env/server": path.resolve(import.meta.dirname, "./tests/stubs/astro-env-server.ts"),
    },
  },
});