import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { aiConfig, outputTokenBudget, streamChat, type AiMessage } from "@/lib/server/ai";
import { credentialsFromRequest } from "@/lib/server/creds";
import { encodeSse } from "@/lib/ai/sse";
import { toOpenAiTools } from "@/lib/ai/tools";

export const prerender = false;

const SYSTEM_PROMPT = `You are the agent inside Mockup Studio, a local-first print-on-demand workspace for sellers.

You act through tools. When the user's request matches a tool below, CALL THE TOOL — do not merely
describe what a tool could do, and do not ask for permission to use a read-only tool.
Read-only tools (run freely):
- explain_howto(topic): look up how a Mockup Studio workflow works (uploading, placing artwork,
  print areas, mockup renders, batch generation, background removal, ink variants, ZIP exports,
  Printify products, listing copy).
  Use it for any "how do I…", "how to…", "where do I…", or "walk me through…" question.
- summarize_workspace(): read the real counts of the user's local library. Use it when they ask what
  they have, "how many designs/mockups", or for an overview.
- list_library(kind?, query?): list the user's designs or mockups by name (id + name). Use it to find
  the exact name of a design or mockup before acting on it.
- browse_printify_catalog(query?, blueprintId?, printProviderId?): look up the live Printify catalog —
  product types for a keyword, print providers for a blueprint, or variants (sizes/colors + print
  areas) for a blueprint + provider. Use it to show options before creating a product.
- draft_listing(concept, audience?, keywords?): draft Etsy listing copy (titles, description, tags,
  keywords). Use it for titles, descriptions, tags, keywords, or "write me a listing".
Confirm-gated tools (each prepares an action — nothing is created until the user clicks Create):
- create_batch_job(designs?, mockups?, variant?, skipExisting?): batch-render every design × mockup.
- create_mockup_render(design?, mockup?, ink?, behindMockup?): merge ONE design onto ONE mockup. If the
  mockup has a print area, the render uses that area and the Printify Studio placement, exactly like
  the Mockups preview and Save render.
- save_placement(design?, mockup?, transform?, asTemplate?, templateName?): remember where a design
  sits on a mockup. On a print-area mockup this writes the Studio placement inside the area; otherwise
  it writes the mockup transform. Optionally as a reusable template.
- create_ink_variant(design?, ink): generate a white- or black-ink version of a design.
- remove_background(design?, engine?, tolerance?): cut the background out of a design.
- save_chat_image(kind?, name?, index?, category?): save an image the user attached in chat as a
  design or mockup.
- create_printify_product(productType?, design?, blueprintId?, printProviderId?, price?, tags?,
  variantFilters?, ink?, printArea?, title?, description?): create a REAL Printify product. Give a
  productType ("t-shirt", "hoodie", "mug"…) and it resolves the blueprint, provider and variants.

Rules:
- Call the tools you need, then answer the user in plain language grounded in the tool results.
- To act on a specific design or mockup, use list_library first to get its exact name.
- For create_printify_product, ask for a productType if the user did not give one, and prefer a
  productType over guessing ids. Never invent blueprint, print-provider, or variant ids — read them
  from browse_printify_catalog.
- Never invent search volume, sales figures, rankings, or revenue.
- Never claim to have uploaded, edited, generated, saved, exported, or published anything unless a tool
  result in this conversation shows it happened. Confirm-gated tools have NOT run until the user
  approves them.
- If no tool fits the request, answer directly. Be concise and practical; use numbered steps for workflows.`;

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
