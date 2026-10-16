import type { APIRoute } from "astro";
import { json, serverEnv } from "@/lib/server/env";

// Server-side integration status check. Never returns secret values — only
// whether credentials are present and basic provider info.
export const GET: APIRoute = () => {
  const printifyKey = serverEnv.printifyApiKey();
  const etsyKey = serverEnv.etsyApiKey();
  const aiKey = serverEnv.aiApiKey() || serverEnv.openaiApiKey();

  return json({
    printify: {
      configured: !!printifyKey,
      providerLabel: "Printify",
      detail: printifyKey
        ? "API key configured on the server."
        : "No API key configured. Add PRINTIFY_API_KEY to .env.local to enable Printify features.",
      checkedAt: Date.now(),
    },
    etsy: {
      configured: !!etsyKey,
      providerLabel: "Etsy",
      detail: etsyKey
        ? "API key configured on the server."
        : "No API key configured. Add ETSY_API_KEY (and OAuth tokens) to .env.local to enable Etsy submission.",
      checkedAt: Date.now(),
    },
    ai: {
      configured: !!(aiKey && (serverEnv.aiBaseUrl() || serverEnv.openaiApiKey())),
      providerLabel: serverEnv.aiBaseUrl()
        ? "Custom OpenAI-compatible provider"
        : "OpenAI-compatible provider",
      detail: aiKey
        ? "AI provider configured on the server."
        : "No AI provider configured. Add AI_API_KEY (and optionally AI_BASE_URL, AI_MODEL) to .env.local to enable AI SEO features.",
      checkedAt: Date.now(),
    },
  });
};
