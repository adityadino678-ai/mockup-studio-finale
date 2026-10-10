import { NextResponse } from "next/server";

// Server-side integration status check. Never returns secret values — only
// whether credentials are present and basic provider info.
export async function GET() {
  const status = {
    printify: {
      configured: !!process.env.PRINTIFY_API_KEY,
      providerLabel: "Printify",
      detail: process.env.PRINTIFY_API_KEY
        ? "API key configured on the server."
        : "No API key configured. Add PRINTIFY_API_KEY to .env.local to enable Printify features.",
      checkedAt: Date.now(),
    },
    etsy: {
      configured: !!process.env.ETSY_API_KEY,
      providerLabel: "Etsy",
      detail: process.env.ETSY_API_KEY
        ? "API key configured on the server."
        : "No API key configured. Add ETSY_API_KEY (and OAuth tokens) to .env.local to enable Etsy submission.",
      checkedAt: Date.now(),
    },
    ai: {
      configured: !!(
        process.env.AI_API_KEY &&
        (process.env.AI_BASE_URL || process.env.OPENAI_API_KEY)
      ),
      providerLabel: process.env.AI_BASE_URL
        ? "Custom OpenAI-compatible provider"
        : "OpenAI-compatible provider",
      detail:
        process.env.AI_API_KEY || process.env.OPENAI_API_KEY
          ? "AI provider configured on the server."
          : "No AI provider configured. Add AI_API_KEY (and optionally AI_BASE_URL, AI_MODEL) to .env.local to enable AI SEO features.",
      checkedAt: Date.now(),
    },
  };
  return NextResponse.json(status);
}
