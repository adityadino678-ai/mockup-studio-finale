import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { AiNotConfiguredError, complete } from "@/lib/server/ai";
import { credentialsFromRequest } from "@/lib/server/creds";

export const prerender = false;

interface TitleRequest {
  prompt?: string;
  reply?: string;
}

export const POST: APIRoute = async ({ request }) => {
  const creds = credentialsFromRequest(request);
  if (!creds.ai) return json({ configured: false, error: "AI provider is not configured." }, 503);

  let body: TitleRequest;
  try {
    body = (await request.json()) as TitleRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return json({ error: "A prompt is required" }, 400);

  try {
    const raw = await complete(
      [
        {
          role: "system",
          content:
            "You name chat threads. Reply with a 3 to 6 word title. No quotes, no trailing period, no markdown, no commentary.",
        },
        {
          role: "user",
          content: `User: ${prompt.slice(0, 400)}\n\nAssistant: ${(body.reply ?? "").slice(0, 400)}`,
        },
      ],
      { temperature: 0.3, maxTokens: 24 },
      creds.ai,
    );
    const title = raw
      .replace(/^["'`\s]+|["'`\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    return json({ configured: true, title: title || "New chat" });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      return json({ error: error.message, configured: false }, 503);
    }
    return json(
      { error: error instanceof Error ? error.message : "Title request failed" },
      502,
    );
  }
};
