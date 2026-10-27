import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { AiNotConfiguredError, aiConfig, complete, parseJsonLoose } from "@/lib/server/ai";
import { credentialsFromRequest } from "@/lib/server/creds";
import { validateBody } from "@/lib/security/validation";

interface SeoResearchInput {
  query?: string;
  activeListings?: number;
  topTags?: Array<{ term?: unknown; count?: unknown }>;
  titleTerms?: Array<{ term?: unknown; count?: unknown }>;
  medianPriceCents?: number;
  currency?: string;
  samples?: Array<{ title?: unknown; tags?: unknown }>;
}

interface SeoRequest {
  niche: string;
  productType?: string;
  audience?: string;
  season?: string;
  seedKeyword?: string;
  /**
   * Optional live Etsy research from `/api/etsy/research`.
   *
   * The AI may use these observed words, but it is never allowed to turn the
   * active-listing count into a search-volume claim. That distinction is the
   * whole reason the research endpoint exists.
   */
  research?: SeoResearchInput;
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

  const validation = validateBody("POST /api/ai/seo", await request.json());
  if (!validation.success) {
    return json({ error: validation.error }, 400);
  }
  const body = validation.data as unknown as SeoRequest;

  if (!body.niche?.trim()) {
    return json({ error: "A niche or concept is required" }, 400);
  }

  const research = body.research;
  const topTags = (research?.topTags ?? [])
    .map((entry) => ({
      term: typeof entry.term === "string" ? entry.term.trim().slice(0, 40) : "",
      count: typeof entry.count === "number" && Number.isFinite(entry.count) ? Math.floor(entry.count) : 0,
    }))
    .filter((entry) => entry.term && entry.count > 0)
    .slice(0, 20);
  const titleTerms = (research?.titleTerms ?? [])
    .map((entry) => ({
      term: typeof entry.term === "string" ? entry.term.trim().slice(0, 40) : "",
      count: typeof entry.count === "number" && Number.isFinite(entry.count) ? Math.floor(entry.count) : 0,
    }))
    .filter((entry) => entry.term && entry.count > 0)
    .slice(0, 20);
  const activeListings =
    typeof research?.activeListings === "number" && Number.isFinite(research.activeListings)
      ? Math.max(0, Math.floor(research.activeListings))
      : undefined;
  const medianPriceCents =
    typeof research?.medianPriceCents === "number" && Number.isFinite(research.medianPriceCents)
      ? Math.max(0, Math.round(research.medianPriceCents))
      : undefined;
  const samples = (research?.samples ?? [])
    .map((sample) => {
      const title = typeof sample.title === "string" ? sample.title.trim().slice(0, 140) : "";
      const tags = Array.isArray(sample.tags)
        ? sample.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean)
            .slice(0, 13)
        : [];
      return title ? `- ${title}${tags.length ? ` (tags: ${tags.join(", ")})` : ""}` : "";
    })
    .filter(Boolean)
    .slice(0, 8);
  const hasResearch = !!(research && (activeListings !== undefined || topTags.length > 0));
  const researchBlock = hasResearch
    ? [
        "Observed Etsy active-listing data (real, read-only):",
        research?.query ? `Query: ${String(research.query).slice(0, 120)}` : "",
        activeListings !== undefined
          ? `Active listings matching the query: ${activeListings} (this is NOT search volume)`
          : "",
        topTags.length
          ? `Recurring tags: ${topTags.map((entry) => `${entry.term} (${entry.count})`).join(", ")}`
          : "",
        titleTerms.length
          ? `Recurring title words: ${titleTerms.map((entry) => `${entry.term} (${entry.count})`).join(", ")}`
          : "",
        medianPriceCents !== undefined
          ? `Median sampled price: ${(medianPriceCents / 100).toFixed(2)} ${
              research?.currency || ""
            }`
          : "",
        samples.length ? `Example active listings:\n${samples.join("\n")}` : "",
        "Use these observed words where they fit naturally. Never call the active-listing count search volume, and never claim sales, revenue, ranking or low competition.",
      ]
        .filter(Boolean)
        .join("\n")
    : "No live Etsy research was supplied. Draft from the seller's niche only; do not pretend to have market data.";

  const userPrompt = `Research and draft listing content for this print-on-demand product.

Niche / concept: ${body.niche.trim()}
Product type: ${body.productType?.trim() || "unspecified"}
Target audience: ${body.audience?.trim() || "unspecified"}
Season / timing: ${body.season?.trim() || "any"}
Seed keyword: ${body.seedKeyword?.trim() || "none"}

${researchBlock}

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
      groundedOnEtsy: hasResearch,
      result: {
        keywords: (payload.keywords ?? []).slice(0, 40),
        productAngles: (payload.productAngles ?? []).slice(0, 10),
        audienceAngles: (payload.audienceAngles ?? []).slice(0, 10),
        seasonalIdeas: (payload.seasonalIdeas ?? []).slice(0, 10),
        titleDrafts,
        descriptionDraft: payload.descriptionDraft ?? "",
        tags,
        disclaimer: hasResearch
          ? "AI-written copy grounded in live Etsy active-listing observations supplied by the app. The active-listing count is not search volume, and no sales or ranking data was used."
          : "AI-generated ideas only. No search volume, ranking, or sales data is included because none was verified.",
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
