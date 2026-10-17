import { beforeEach, describe, expect, it, vi } from "vitest";
import { SseParser, decodeSseData, encodeSse } from "@/lib/ai/sse";
import { modelCapabilities, modelReasoning } from "@/lib/ai/providers";
import { parseProviderStreamLine, retryFix } from "@/lib/server/ai";
import {
  addMessage,
  consumeStream,
  createConversation,
  deleteConversation,
  estimateTokens,
  loadFavorites,
  patchToolCall,
  renameConversation,
  saveFavorites,
  setConversationPinned,
  toApiMessages,
} from "@/lib/client/chat";
import { executeTool } from "@/lib/client/tools";
import { agentTool, parseToolArguments, routeIntent, toOpenAiTools } from "@/lib/ai/tools";
import { db } from "@/lib/db/schema";
import type { ChatMessage } from "@/types/domain";

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

describe("SSE framing", () => {
  it("round-trips an encoded frame through the parser", () => {
    const parser = new SseParser();
    const frames = parser.push(encodeSse("delta", { text: "hello" }));
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("delta");
    expect(decodeSseData<{ text: string }>(frames[0])?.text).toBe("hello");
  });

  it("buffers partial frames split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("event: delta\ndata: {\"text\":\"a")).toEqual([]);
    const frames = parser.push("\"}\n\n");
    expect(frames).toHaveLength(1);
    expect(decodeSseData<{ text: string }>(frames[0])?.text).toBe("a");
  });

  it("flushes a trailing frame with no blank line", () => {
    const parser = new SseParser();
    parser.push("event: done\ndata: {}");
    expect(parser.flush()).toHaveLength(1);
  });

  it("returns null for malformed JSON data", () => {
    expect(decodeSseData({ event: "delta", data: "not json" })).toBeNull();
  });
});

describe("provider streaming line parsing", () => {
  it("extracts content deltas", () => {
    const events = parseProviderStreamLine('data: {"choices":[{"delta":{"content":"Hi"}}]}');
    expect(events).toEqual([{ type: "delta", text: "Hi" }]);
  });

  it("extracts reasoning deltas and usage", () => {
    const reasoning = parseProviderStreamLine(
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
    );
    expect(reasoning).toEqual([{ type: "reasoning", text: "think" }]);
    const usage = parseProviderStreamLine('data: {"choices":[{"delta":{}}],"usage":{"total_tokens":5}}');
    expect(usage[0].type).toBe("usage");
  });

  it("recognises the terminator and ignores comments/non-data lines", () => {
    expect(parseProviderStreamLine("data: [DONE]")).toEqual([{ type: "done" }]);
    expect(parseProviderStreamLine(": keep-alive")).toEqual([]);
    expect(parseProviderStreamLine("event: ping")).toEqual([]);
  });
});

describe("model capabilities", () => {
  it("detects reasoning models", () => {
    for (const id of ["o3-mini", "gpt-5", "deepseek-reasoner", "qwen/qwq-32b", "openai/o4-mini", "glm-4.5:thinking"]) {
      expect(modelReasoning(id), id).toBe(true);
    }
    for (const id of ["gpt-4o-mini", "llama-3.3-70b-versatile", "claude-3-5-sonnet"]) {
      expect(modelReasoning(id), id).toBe(false);
    }
  });

  it("reports provider-level tools/vision flags", () => {
    expect(modelCapabilities("openai", "gpt-4o")).toEqual({ reasoning: false, tools: true, vision: true });
    expect(modelCapabilities("groq", "llama-3.3-70b-versatile")).toEqual({
      reasoning: false,
      tools: true,
      vision: false,
    });
    expect(modelCapabilities("unknown", "x")).toEqual({ reasoning: false, tools: false, vision: false });
  });
});

describe("chat store", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("creates, renames and pins a conversation", async () => {
    const c = await createConversation("groq", "llama-3.3-70b-versatile", "First message");
    expect(c.title).toBe("First message");
    await renameConversation(c.id, "Renamed");
    await setConversationPinned(c.id, true);
    const stored = await db.conversations.get(c.id);
    expect(stored?.title).toBe("Renamed");
    expect(stored?.pinned).toBe(true);
  });

  it("deletes a conversation and its messages together", async () => {
    const c = await createConversation("groq", "m", "t");
    await addMessage(c.id, "user", [{ type: "text", text: "hi" }]);
    await addMessage(c.id, "assistant", [{ type: "text", text: "hello" }]);
    await deleteConversation(c.id);
    expect(await db.conversations.get(c.id)).toBeUndefined();
    expect(await db.messages.where("conversationId").equals(c.id).count()).toBe(0);
  });

  it("persists favorite model keys", async () => {
    await db.delete();
    await db.open();
    await saveFavorites(["groq/llama-3.3-70b-versatile"]);
    expect(await loadFavorites()).toEqual(["groq/llama-3.3-70b-versatile"]);
  });
});

describe("toApiMessages", () => {
  it("skips empty turns and flattens text parts", () => {
    const messages: ChatMessage[] = [
      { id: "1", conversationId: "c", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 1 },
      { id: "2", conversationId: "c", role: "assistant", parts: [{ type: "reasoning", text: "…" }], createdAt: 2 },
    ];
    expect(toApiMessages(messages)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("builds multimodal content when images are attached", () => {
    const messages: ChatMessage[] = [
      {
        id: "1",
        conversationId: "c",
        role: "user",
        parts: [
          { type: "text", text: "what is this" },
          { type: "image", image: { name: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,xx" } },
        ],
        createdAt: 1,
      },
    ];
    const api = toApiMessages(messages);
    expect(Array.isArray(api[0].content)).toBe(true);
    const parts = api[0].content as Array<{ type: string }>;
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image_url");
  });

  it("estimates tokens from character count", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});

describe("consumeStream", () => {
  it("accumulates deltas and reasoning, then stops on done", async () => {
    const onDelta = vi.fn();
    const onReasoning = vi.fn();
    const result = await consumeStream(
      sseResponse([
        encodeSse("reasoning", { text: "why" }),
        encodeSse("delta", { text: "Hel" }),
        encodeSse("delta", { text: "lo" }),
        encodeSse("done", { model: "m" }),
      ]),
      { onDelta, onReasoning },
    );
    expect(result.text).toBe("Hello");
    expect(result.reasoning).toBe("why");
    expect(result.error).toBeUndefined();
    expect(onDelta).toHaveBeenCalledWith("Hel");
    expect(onDelta).toHaveBeenCalledWith("lo");
    expect(onReasoning).toHaveBeenCalledWith("why");
  });

  it("surfaces a provider error frame", async () => {
    const result = await consumeStream(
      sseResponse([encodeSse("delta", { text: "partial" }), encodeSse("error", { message: "boom" })]),
    );
    expect(result.text).toBe("partial");
    expect(result.error).toBe("boom");
  });

  it("captures a tool_calls frame", async () => {
    const result = await consumeStream(
      sseResponse([
        encodeSse("tool_calls", {
          calls: [{ id: "c1", type: "function", function: { name: "summarize_workspace", arguments: "{}" } }],
        }),
        encodeSse("done", { model: "m" }),
      ]),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].function.name).toBe("summarize_workspace");
  });

  it("passes every raw frame to onFrame in order", async () => {
    const seen: string[] = [];
    await consumeStream(
      sseResponse([
        encodeSse("debug", { model: "m", tools: [] }),
        encodeSse("delta", { text: "hi" }),
        encodeSse("done", { model: "m" }),
      ]),
      { onFrame: (frame) => seen.push(frame.event) },
    );
    expect(seen).toEqual(["debug", "delta", "done"]);
  });
});

describe("agent tools", () => {
  it("marks only the writing tool as needing confirmation", () => {
    expect(agentTool("create_batch_job")?.confirm).toBe(true);
    expect(agentTool("create_printify_product")?.confirm).toBe(true);
    expect(agentTool("explain_howto")?.confirm).toBeFalsy();
    expect(agentTool("summarize_workspace")?.confirm).toBeFalsy();
    expect(agentTool("draft_listing")?.confirm).toBeFalsy();
    expect(agentTool("nope")).toBeUndefined();
  });

  it("builds OpenAI tool defs for the requested subset only", () => {
    const defs = toOpenAiTools(["summarize_workspace", "bogus", "explain_howto"]);
    expect(defs.map((d) => d.function.name)).toEqual(["summarize_workspace", "explain_howto"]);
    expect(defs[0].type).toBe("function");
  });

  it("parses tool arguments tolerantly", () => {
    expect(parseToolArguments('{"topic":"upload"}')).toEqual({ topic: "upload" });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("not json")).toEqual({});
    expect(parseToolArguments("[1,2]")).toEqual({});
  });

  it("routes obvious requests to the right tool", () => {
    expect(routeIntent("how do I upload a design")?.name).toBe("explain_howto");
    expect(routeIntent("how many designs do I have")?.name).toBe("summarize_workspace");
    expect(routeIntent("draft me an Etsy listing for cat mugs")?.name).toBe("draft_listing");
    expect(routeIntent("generate a batch of all designs and mockups")?.name).toBe("create_batch_job");
    expect(routeIntent("list this design on printify")?.name).toBe("create_printify_product");
    expect(routeIntent("create a printify product for my art")?.name).toBe("create_printify_product");
  });

  it("returns null when nothing matches an intent", () => {
    expect(routeIntent("hello there")).toBeNull();
    expect(routeIntent("")).toBeNull();
  });

  it("carries the user text into explain_howto args", () => {
    const routed = routeIntent("how do I remove a background?");
    expect(routed?.name).toBe("explain_howto");
    expect(String(routed?.args.topic)).toContain("background");
  });
});

describe("provider request recovery", () => {
  it("renames max_tokens to max_completion_tokens when the provider requires it", () => {
    const fixed = retryFix({ model: "m", max_tokens: 100 }, "Unsupported parameter: max_completion_tokens");
    expect(fixed).toEqual({ model: "m", max_completion_tokens: 100 });
  });

  it("drops reasoning_effort when the model rejects it", () => {
    expect(retryFix({ model: "m", reasoning_effort: "high" }, "reasoning_effort is not supported")).toEqual({
      model: "m",
    });
  });

  it("drops tools when the model cannot call functions", () => {
    expect(
      retryFix({ model: "m", tools: [], tool_choice: "auto", temperature: 0.7 }, "This model does not support tools"),
    ).toEqual({ model: "m", temperature: 0.7 });
  });

  it("returns null when the error cannot be fixed by changing the request", () => {
    expect(retryFix({ model: "m" }, "Incorrect API key provided")).toBeNull();
  });
});

describe("provider tool-call streaming", () => {
  it("emits tool_delta events from a delta payload", () => {
    const events = parseProviderStreamLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"draft_listing","arguments":"{\\"conce"}}]}}]}',
    );
    expect(events).toContainEqual({
      type: "tool_delta",
      index: 0,
      id: "c1",
      name: "draft_listing",
      args: '{"conce',
    });
  });
});

describe("toApiMessages tool replay", () => {
  it("replays completed tool calls as assistant + tool pairs", () => {
    const messages: ChatMessage[] = [
      { id: "1", conversationId: "c", role: "user", parts: [{ type: "text", text: "summarize" }], createdAt: 1 },
      {
        id: "2",
        conversationId: "c",
        role: "assistant",
        parts: [
          { type: "text", text: "On it." },
          {
            type: "tool",
            call: {
              id: "c1",
              name: "summarize_workspace",
              args: {},
              status: "done",
              result: { designs: 2 },
            },
          },
        ],
        createdAt: 2,
      },
    ];
    const api = toApiMessages(messages);
    expect(api).toHaveLength(3);
    expect(api[1].role).toBe("assistant");
    expect(api[1].content).toBe("On it.");
    expect(api[1].tool_calls?.[0].function.name).toBe("summarize_workspace");
    expect(api[2].role).toBe("tool");
    expect(api[2].tool_call_id).toBe("c1");
    expect(api[2].content).toBe(JSON.stringify({ designs: 2 }));
  });

  it("omits tool calls that never got a result", () => {
    const messages: ChatMessage[] = [
      {
        id: "2",
        conversationId: "c",
        role: "assistant",
        parts: [
          {
            type: "tool",
            call: { id: "c1", name: "create_batch_job", args: {}, status: "pending", summary: "…" },
          },
        ],
        createdAt: 2,
      },
    ];
    expect(toApiMessages(messages)).toEqual([]);
  });
});

describe("tool executors", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("answers a known how-to question", async () => {
    const result = await executeTool("explain_howto", { topic: "how do I upload a design" });
    expect(result.error).toBeUndefined();
    expect(String((result.result as { answer: string }).answer)).toContain("Designs page");
  });

  it("counts the workspace from IndexedDB", async () => {
    await db.designs.put({
      id: "d1",
      name: "Sunset",
      tags: [],
      originalAssetId: "a1",
      activeVariant: "main",
      createdAt: 1,
      updatedAt: 1,
    });
    const result = await executeTool("summarize_workspace", {});
    expect((result.result as { designs: number }).designs).toBe(1);
    expect(result.summary).toContain("1 designs");
  });

  it("refuses to propose a batch with nothing to work on", async () => {
    const result = await executeTool("create_batch_job", {});
    expect(result.error).toBeDefined();
    expect(result.confirmation).toBeUndefined();
  });

  it("proposes a batch without writing anything", async () => {
    await db.designs.put({
      id: "d1",
      name: "Sunset",
      tags: [],
      originalAssetId: "a1",
      activeVariant: "main",
      createdAt: 1,
      updatedAt: 1,
    });
    await db.mockups.put({
      id: "m1",
      name: "Tee",
      category: "tshirt",
      tags: [],
      favorite: false,
      assetId: "a2",
      width: 100,
      height: 100,
      source: "user",
      createdAt: 1,
    });
    const result = await executeTool("create_batch_job", { variant: "white" });
    expect(result.error).toBeUndefined();
    expect(result.confirmation?.payload.total).toBe(1);
    expect(result.confirmation?.payload.variant).toBe("white");
    expect(await db.batchJobs.count()).toBe(0);
  });

  it("refuses to propose a Printify product without a design", async () => {
    const result = await executeTool("create_printify_product", {});
    expect(result.error).toBeDefined();
    expect(result.confirmation).toBeUndefined();
  });

  it("asks for a blueprint instead of inventing one", async () => {
    await db.designs.put({
      id: "d1",
      name: "Sunset",
      tags: [],
      originalAssetId: "a1",
      activeVariant: "main",
      createdAt: 1,
      updatedAt: 1,
    });
    const result = await executeTool("create_printify_product", { design: "sunset", price: 1999 });
    expect(result.summary).toContain("Blueprint");
    expect(result.confirmation).toBeUndefined();
  });

  it("proposes a Printify product once ids and a price are given", async () => {
    await db.designs.put({
      id: "d1",
      name: "Sunset",
      tags: [],
      originalAssetId: "a1",
      activeVariant: "main",
      createdAt: 1,
      updatedAt: 1,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            configured: true,
            blueprint: {
              id: 6,
              title: "Tee",
              variants: [
                { id: 1, available: true },
                { id: 2, available: true },
                { id: 3, available: false },
              ],
              print_areas: [{ id: "front" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeTool("create_printify_product", {
      design: "sunset",
      blueprintId: 6,
      printProviderId: 99,
      price: 1999,
    });
    vi.unstubAllGlobals();
    expect(result.error).toBeUndefined();
    expect(result.confirmation?.payload.variantIds).toEqual([1, 2]);
    expect(result.confirmation?.payload.printArea).toBe("front");
    expect(result.confirmation?.payload.price).toBe(1999);
    expect(await db.productDrafts.count()).toBe(0);
  });

  it("reports an unknown tool instead of guessing", async () => {
    const result = await executeTool("delete_everything", {});
    expect(result.error).toContain("No tool named");
  });
});

describe("patchToolCall", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("updates one tool part in place", async () => {
    const c = await createConversation("groq", "m", "t");
    const message = await addMessage(c.id, "assistant", [
      { type: "tool", call: { id: "c1", name: "create_batch_job", args: {}, status: "pending" } },
    ]);
    await patchToolCall(message.id, "c1", { status: "done", result: { jobId: "j1" } });
    const stored = await db.messages.get(message.id);
    const part = stored?.parts[0];
    expect(part?.type).toBe("tool");
    if (part?.type === "tool") {
      expect(part.call.status).toBe("done");
      expect(part.call.result).toEqual({ jobId: "j1" });
    }
  });
});
