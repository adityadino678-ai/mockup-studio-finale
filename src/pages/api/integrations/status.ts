import type { APIRoute } from "astro";
import { json, serverEnv } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { getProvider } from "@/lib/ai/providers";

// Server-side integration status check. Never returns secret values — only
// whether credentials are present (in the browser request or on the server),
// which source they came from, and basic provider info.
export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  const creds = credentialsFromRequest(request);
  const etsyKey = serverEnv.etsyApiKey();
  const aiProviderLabel = creds.ai ? (getProvider(creds.ai.provider)?.label ?? creds.ai.provider) : null;

  return json({
    printify: {
      configured: !!creds.printify,
      source: creds.printify?.source ?? null,
      providerLabel: "Printify",
      detail: creds.printify
        ? creds.printify.source === "browser"
          ? "Connected using the API key saved in this browser."
          : "Printify connected on the server via PRINTIFY_API_KEY."
        : "No Printify key. Paste yours in Settings (stored in this browser) or set PRINTIFY_API_KEY on the server.",
      checkedAt: Date.now(),
    },
    etsy: {
      configured: !!etsyKey,
      source: etsyKey ? "server" : null,
      providerLabel: "Etsy",
      detail: etsyKey
        ? "Etsy API key configured on the server."
        : "No Etsy key. Etsy submission is a draft-only feature and needs server-side OAuth to go live.",
      checkedAt: Date.now(),
    },
    ai: {
      configured: !!creds.ai,
      source: creds.ai?.source ?? null,
      provider: creds.ai?.provider ?? null,
      providerLabel: creds.ai ? `${aiProviderLabel} · ${creds.ai.model}` : "OpenAI-compatible provider",
      detail: creds.ai
        ? creds.ai.source === "browser"
          ? `AI provider ready — ${aiProviderLabel} · ${creds.ai.model} via the key saved in this browser.`
          : `AI provider ready — ${aiProviderLabel} · ${creds.ai.model} configured on the server.`
        : "No AI provider configured. Pick a provider and paste your API key in Settings to enable AI features.",
      checkedAt: Date.now(),
    },
  });
};
