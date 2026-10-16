import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { AiNotConfiguredError, aiConfig, complete } from "@/lib/server/ai";

const SYSTEM_PROMPT = `You are the assistant inside Mockup Studio, a local-first print-on-demand workspace.

Your job is to help the user operate the app. Rules:
- The assistant CANNOT perform actions. It can only explain and guide. It must never claim that it
  uploaded, edited, generated, saved, exported, or published anything.
- Describe only these real capabilities: uploading designs and mockups (stored in the browser),
  the mockup editor (move/resize/rotate/flip/opacity with undo-redo), batch generation with live
  per-item status, background removal (flood-key or a local MODNet model), white/black ink variants,
  templates, ZIP exports, product drafts, Etsy listing drafts, and AI SEO research.
- If the user asks for an external action (publishing to Printify or Etsy), explain that it requires
  credentials and an explicit confirmation.
- Never invent search volume, sales figures, rankings, or revenue.
- Be concise and practical. Use short numbered steps when walking through a workflow.`;

interface AssistantRequest {
  question: string;
  page?: string;
  context?: {
    designs?: number;
    mockups?: number;
    pendingRenders?: number;
    aiConfigured?: boolean;
    printifyConfigured?: boolean;
    etsyConfigured?: boolean;
  };
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const { configured, model } = aiConfig();
  if (!configured) {
    return json(
      {
        configured: false,
        error:
          "The assistant needs an AI provider. Add AI_API_KEY to .env.local to enable Q&A. The quick actions on this panel work without it.",
      },
      503,
    );
  }

  let body: AssistantRequest;
  try {
    body = (await request.json()) as AssistantRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.question?.trim()) {
    return json({ error: "A question is required" }, 400);
  }

  const ctx = body.context ?? {};
  const contextLine = [
    body.page ? `Current page: ${body.page}` : null,
    `Workspace contents: ${ctx.designs ?? 0} designs, ${ctx.mockups ?? 0} mockups.`,
    ctx.pendingRenders ? `${ctx.pendingRenders} batch items still pending.` : null,
    `Integrations: AI ${ctx.aiConfigured ? "configured" : "not configured"}, Printify ${
      ctx.printifyConfigured ? "configured" : "not configured"
    }, Etsy ${ctx.etsyConfigured ? "configured" : "not configured"}.`,
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const answer = await complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${contextLine}\n\nQuestion: ${body.question.trim()}` },
      ],
      { temperature: 0.4, maxTokens: 700 },
    );
    return json({ configured: true, model, answer });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      return json({ error: error.message, configured: false }, 503);
    }
    return json(
      { error: error instanceof Error ? error.message : "Assistant request failed" },
      502,
    );
  }
};
