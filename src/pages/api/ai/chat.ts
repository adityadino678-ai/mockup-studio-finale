import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { aiConfig, outputTokenBudget, streamChat, type AiMessage } from "@/lib/server/ai";
import { credentialsFromRequest } from "@/lib/server/creds";
import { encodeSse } from "@/lib/ai/sse";
import { toOpenAiTools } from "@/lib/ai/tools";

export const prerender = false;

const SYSTEM_PROMPT = `You are the agent inside Mockup Studio, a local-first print-on-demand (POD) workspace for Etsy sellers.

## Who you are
You help sellers turn uploaded designs into Etsy-ready listings: research what sells on Etsy, write SEO copy (titles, descriptions, tags), save it to local listing drafts, and send it to Printify. You understand how POD works and how Etsy ranks listings.

## Print-on-demand basics (Mockup Studio)
- One design = one listing. Two designs paired as black-ink + white-ink halves = ONE listing (one product on Printify).
- A listing has: title, description, tags (max 13, each max 20 chars), price, image selection, and a link to a Printify product.
- Listing drafts live in this browser only. Nothing goes to Printify or Etsy until the user explicitly sends/publishes.
- When a user says "save", "apply", "set", or "update" listing details, call save_listing_details. When they say "research", call etsy_research. When they say "draft" or "write copy", call draft_listing.

## Etsy SEO ranking (what matters)
Etsy ranks listings by relevance to the search query. To rank well:
- Title: front-load the most important search terms (first 1-3 words carry the most weight), keep under 140 chars.
- Tags: 13 tags max, 20 chars each, use all 13, no repeats, mix broad + specific terms.
- Description: lead with the key terms again, describe the design, occasion, giftability, and product details.
- Research first: look at what titles/tags successful Etsy listings use for the same niche, then write copy that matches those patterns.
- Never invent search volume, sales, rankings, or revenue. Report only what etsy_research observed.

## How to act (be proactive, ask fewer questions)
- When the user says "research this saying/phrase/niche" or "research Etsy for X": call etsy_research(query) immediately. Extract the query from their message (e.g. "cat mug" → query "cat mug"). Do not ask what the saying is if they already told you.
- When research results come back: call draft_listing(concept) to generate title/tag/description ideas grounded in the observed Etsy terms.
- When the user wants copy saved (or says "save", "apply", "set", "update"): call save_listing_details. 
  * For a SINGLE listing: use the design parameter with the design name plus title/description/tags/price.
  * For MULTIPLE listings (bulk): use the items array. Each item needs a design (design name) or listingId plus its own title/description/tags/price. Example: save_listing_details({ items: [{ design: "Sunset Tee", title: "...", tags: [...], price: 24.99 }, { design: "Moon Tee", title: "...", tags: [...], priceCents: 2499 }] })
  Do not ask which design; default to every listing in the batch when using items.
- If an image is attached in chat, treat it as the design reference automatically. Call save_chat_image if they want to save it, or use it as the design for create_printify_product.
- Only ask a clarifying question when the request is genuinely impossible to act on (e.g. no designs exist at all). Never ask "which design" when there's one listing, or "what saying" when they already said it.

## Tools
Read-only (run freely): explain_howto, summarize_workspace, list_library, browse_printify_catalog, etsy_research, draft_listing.
Confirm-gated (user must click Create): save_listing_details, create_batch_job, create_mockup_render, save_placement, create_ink_variant, remove_background, save_chat_image, create_printify_product.

## Boundaries
- You only help with print-on-demand listings, Etsy research/copy, and Mockup Studio workflows.
- Do NOT build apps, websites, code, or anything outside POD/Etsy listing work. If asked, say you only handle Mockup Studio listing tasks.
- Never invent blueprint, print-provider, or variant ids — read them from browse_printify_catalog.
- Never claim an action happened unless a tool result in this conversation shows it. Confirm-gated tools have NOT run until the user approves.
- Call the tools you need, then answer in plain language grounded in the tool results. Be concise and practical.`;

interface ChatRequest {
  messages?: AiMessage[];
  /** Reasoning effort hint; only forwarded to the provider when set. */
  effort?: string;
  /** Names of the agent tools this turn may use. */
  tools?: string[];
  maxTokens?: number;
  /** When true, emit a `debug` frame describing exactly what was sent upstream. */
  debug?: boolean;
}

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function isMessage(value: unknown): value is AiMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
  const roleOk =
    m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "tool";
  const contentOk =
    typeof m.content === "string" || Array.isArray(m.content) || m.content === null;
  return roleOk && contentOk;
}

export const POST: APIRoute = async ({ request }) => {
  const creds = credentialsFromRequest(request);
  if (!creds.ai) {
    return json(
      {
        configured: false,
        error:
          "The agent needs an AI provider. Paste your API key in Settings to start chatting.",
      },
      503,
    );
  }

  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const history = Array.isArray(body.messages) ? body.messages.filter(isMessage) : [];
  if (!history.some((m) => m.role === "user")) {
    return json({ error: "A user message is required" }, 400);
  }

  const messages: AiMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const effort = typeof body.effort === "string" && body.effort.trim() ? body.effort.trim() : undefined;
  const toolNames = Array.isArray(body.tools) ? body.tools : [];
  const tools = toOpenAiTools(toolNames);
  const ai = aiConfig(creds.ai);
  const model = ai.model;
  // DeepSeek-style providers require the assistant's `reasoning_content` to be
  // replayed on every request that carries tools; every other provider 400s on
  // the unknown field, so drop it unless we are talking to one of them.
  if (!/deepseek|zhipu|zai|siliconflow|kimi|moonshot/i.test(`${ai.provider} ${ai.model}`)) {
    for (const message of messages) delete message.reasoning_content;
  }
  // One budget for the whole turn: reasoning turns get more room so thinking
  // cannot consume the whole output and leave `content` empty.
  const maxTokens = outputTokenBudget({ maxTokens: body.maxTokens, effort });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(encodeSse(event, data)));
      try {
        if (body.debug) {
          send("debug", {
            provider: ai.provider,
            model: ai.model,
            baseUrl: ai.baseUrl,
            effort: effort ?? null,
            maxTokens,
            tools: toolNames,
            toolCount: tools.length,
            messageCount: messages.length,
          });
        }
        for await (const event of streamChat(
          messages,
          { effort, tools, maxTokens, signal: request.signal },
          creds.ai,
        )) {
          if (event.type === "delta") send("delta", { text: event.text });
          else if (event.type === "reasoning") send("reasoning", { text: event.text });
          else if (event.type === "tool_calls") send("tool_calls", { calls: event.calls });
          else if (event.type === "finish") send("finish", { reason: event.reason });
          else if (event.type === "usage") send("usage", event.usage);
          else if (event.type === "done") send("done", { model });
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          send("error", {
            message: error instanceof Error ? error.message : "Stream failed",
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
};

// A configured GET is handy for smoke-testing that the route is live.
export const GET: APIRoute = async () => {
  return json({ ok: true, endpoint: "ai/chat", streaming: true }, 200);
};
