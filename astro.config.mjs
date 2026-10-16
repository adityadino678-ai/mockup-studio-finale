// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Mockup Studio runs fully on the user's machine: on-demand rendering so the
// `/api/**` endpoints can reach Printify/AI secrets server-side, and the Node
// adapter in standalone mode so `npm run build && npm run preview` works with
// plain `node dist/server/entry.mjs`.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  server: { port: 3000 },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
  },
});
