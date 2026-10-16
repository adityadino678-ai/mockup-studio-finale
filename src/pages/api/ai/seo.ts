import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { AiNotConfiguredError, aiConfig, complete, parseJsonLoose } from "@/lib/server/ai";
import { credentialsFromRequest } from "@/lib/server/creds";

interface SeoRequest {
  niche: string;
  productType?: string;
  audience?: string;
  season?: string;
  seedKeyword?: string;
}

interface SeoPayload {
  keywords: Array<{ term: string; intent: string; rationale?: string }>;
  productAngles: string[];
  audienceAngles: string[];
  seasonalIdeas: string[];
  titleDrafts: string[];
  descriptionDraft: string;
  tags: string[];
  disclaimer?: string;
}

const SYSTEM_PROMPT = `You help print-on-demand sellers research and write Etsy listings.
Rules you must follow:
- Never invent search volumes, sales figures, rankings, revenue, or competitor data.
- Only suggest keywords and angles as ideas for the seller to evaluate.
- Keep Etsy constraints in mind: title max 140 characters, at most 13 tags of 20 characters each.
- Tags must each be 20 characters or fewer.
- Be concrete and specific to the seller's niche and product.
Return strictly JSON matching the requested shape, no commentary.`;

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const creds = credentialsFromRequest(request);
  if (!creds.ai) {
    return json(
      {
        configured: false,
        error:
          "AI provider is not configured. Paste your API key (and base URL / model) in Settings. Everything else in Mockup Studio keeps working without it.",
      },
      503,
    );
  }

  let body: SeoRequest;
  try {
    body = (await request.json()) as SeoRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.niche?.trim()) {
    return json({ error: "A niche or concept is required" }, 400);
  }

  const userPrompt = `Research and draft listing content for this print-on-demand product.

Niche / concept: ${body.niche.trim()}
Product type: ${body.productType?.trim() || "unspecified"}
Target audience: ${body.audience?.trim() || "unspecified"}
Season / timing: ${body.season?.trim() || "any"}
Seed keyword: ${body.seedKeyword?.trim() || "none"}

Return JSON with exactly these keys:
{
  "keywords": [{"term": string, "intent": "search|discovery|gifting|seasonal|problem-solution"}],
  "productAngles": [string],
  "audienceAngles": [string],
  "seasonalIdeas": [string],
  "titleDrafts": [string],
  "descriptionDraft": string,
  "tags": [string]
}
Rules: 15-25 keywords; 4-6 title drafts each under 140 characters; exactly 13 tags each 20 characters or fewer; description 3 short paragraphs.`;

  try {
    const raw = await complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { jsonMode: true, temperature: 0.7, maxTokens: 1800 },
      creds.ai,
    );
    const payload = parseJsonLoose<SeoPayload>(raw);

    // Server-side validation against Etsy constraints â€” never trust the model.
    const tags = (payload.tags ?? [])
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0 && t.length <= 20)
      .slice(0, 13);
    const titleDrafts = (payload.titleDrafts ?? [])
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0 && t.length <= 140)
      .slice(0, 8);

    return json({
      configured: true,
      model: aiConfig(creds.ai).model,
      researchedAt: new Date().toISOString(),
      result: {
        keywords: (payload.keywords ?? []).slice(0, 40),
        productAngles: (payload.productAngles ?? []).slice(0, 10),
        audienceAngles: (payload.audienceAngles ?? []).slice(0, 10),
        seasonalIdeas: (payload.seasonalIdeas ?? []).slice(0, 10),
        titleDrafts,
        descriptionDraft: payload.descriptionDraft ?? "",
        tags,
        disclaimer:
          "AI-generated ideas only. No search volume, ranking, or sales data is included because none was verified.",
      },
    });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      return json({ error: error.message, configured: false }, 503);
    }
    return json(
      { error: error instanceof Error ? error.message : "AI request failed" },
      502,
    );
  }
};
