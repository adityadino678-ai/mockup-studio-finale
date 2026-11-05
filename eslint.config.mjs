import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import astro from "eslint-plugin-astro";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".astro/**",
      // Wrangler writes bundles of generated code here on every `wrangler dev`.
      ".wrangler/**",
      "test-results/**",
      "public/**",
      // Local scratch scripts and the standalone Printify bridge extension are
      // not part of the Astro/TS build (the extension loads unpacked in a
      // browser with its own manifest and `chrome.*` globals).
      "tmp/**",
      "extension/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    files: ["**/*.{ts,tsx,astro,mjs,js}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/pages/**/*.{ts,tsx}"],
    rules: {
      "no-console": "off",
    },
  },
  prettier,
];
