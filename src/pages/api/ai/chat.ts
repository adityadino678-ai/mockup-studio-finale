import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { aiConfig, streamChat, type AiMessage } from "@/lib/server/ai";
import { credentialsFromRequest } from "@/lib/server/creds";
import { encodeSse } from "@/lib/ai/sse";
import { toOpenAiTools } from "@/lib/ai/tools";

export const prerender = false;

const SYSTEM_PROMPT = `You are the agent inside Mockup Studio, a local-first print-on-demand workspace.

Rules:
- You may explain, plan, and draft copy. You must never claim to have uploaded, edited, generated,
  saved, exported, or published anything unless a tool result in this conversation shows it happened.
- Real capabilities in this app: uploading designs and mockups (stored in the browser), the mockup
  editor, batch generation, background removal, ink variants, templates, ZIP exports, product drafts,
  Etsy listing drafts, and AI SEO research.
- Never invent search volume, sales figures, rankings, or revenue.
- Be concise and practical. Prefer short paragraphs and numbered steps for workflows.
- When a tool is available and the user asks for something it does, call the tool instead of guessing.
  Some tools (like creating a batch job) only prepare a proposal; the user confirms before anything runs.`;

interface ChatRequest {
  messages?: AiMessage[];
  /** Reasoning effort hint; only forwarded to the provider when set. */
  effort?: string;
  /** Names of the agent tools this turn may use. */
  tools?: string[];
  maxTokens?: number;
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
  const tools = toOpenAiTools(Array.isArray(body.tools) ? body.tools : []);
  const model = aiConfig(creds.ai).model;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(encodeSse(event, data)));
      try {
        for await (const event of streamChat(
          messages,
          { effort, tools, maxTokens: body.maxTokens, signal: request.signal },
          creds.ai,
        )) {
          if (event.type === "delta") send("delta", { text: event.text });
          else if (event.type === "reasoning") send("reasoning", { text: event.text });
          else if (event.type === "tool_calls") send("tool_calls", { calls: event.calls });
          else if (event.type === "usage") send("usage", event.usage);
          else if (event.type === "done") {
            send("done", { model });
            break;
          }
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
