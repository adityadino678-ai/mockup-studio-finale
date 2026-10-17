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
import {
  CONFIRM_TOOL_RUNNERS,
  confirmInkVariant,
  confirmMockupRender,
  confirmRemoveBackground,
  confirmSaveChatImage,
  confirmSavePlacement,
  executeTool,
} from "@/lib/client/tools";
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
  it("marks every writing tool as needing confirmation", () => {
    for (const name of [
      "create_batch_job",
      "create_mockup_render",
      "save_placement",
      "create_ink_variant",
      "remove_background",
      "save_chat_image",
      "create_printify_product",
    ]) {
      expect(agentTool(name)?.confirm, name).toBe(true);
    }
    for (const name of ["explain_howto", "summarize_workspace", "list_library", "browse_printify_catalog", "draft_listing"]) {
      expect(agentTool(name)?.confirm, name).toBeFalsy();
    }
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
    expect(routeIntent("make a mockup of my design")?.name).toBe("create_mockup_render");
    expect(routeIntent("remove the background from my design")?.name).toBe("remove_background");
    expect(routeIntent("make a white ink version of the sunset")?.name).toBe("create_ink_variant");
    expect(routeIntent("save the placement for this design")?.name).toBe("save_placement");
    expect(routeIntent("save this image as a design")?.name).toBe("save_chat_image");
    expect(routeIntent("list my designs")?.name).toBe("list_library");
    expect(routeIntent("browse the printify catalog")?.name).toBe("browse_printify_catalog");
  });

  it("pulls a product type and price out of a printify request", () => {
    const routed = routeIntent("create a printify hoodie for my art at $32");
    expect(routed?.name).toBe("create_printify_product");
    expect(routed?.args.productType).toBe("hoodie");
    expect(routed?.args.price).toBe(3200);
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

  it("asks for a product type instead of inventing a blueprint", async () => {
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
    expect(result.summary).toContain("Product type");
    expect(result.error).toBeDefined();
    expect(result.confirmation).toBeUndefined();
  });

  it("resolves blueprint, provider and variants from a product type", async () => {
    await db.designs.put({
      id: "d1",
      name: "Sunset",
      tags: [],
      originalAssetId: "a1",
      activeVariant: "main",
      createdAt: 1,
      updatedAt: 1,
    });
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      let payload: unknown = { configured: true };
      if (u.includes("q=")) {
        payload = { configured: true, blueprints: [{ id: 6, title: "Unisex Tee", brand: "Gildan" }] };
      } else if (u.includes("providers=1")) {
        payload = { configured: true, providers: [{ id: 30, title: "Provider A" }] };
      } else {
        payload = {
          configured: true,
          variants: [
            { id: 11, available: true, options: { color: "Black", size: "M" }, placeholders: [{ position: "front" }] },
            { id: 12, available: true, options: { color: "White", size: "L" }, placeholders: [{ position: "front" }] },
          ],
        };
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeTool("create_printify_product", {
      design: "sunset",
      productType: "t-shirt",
      tags: ["cat", "cat", "gift"],
    });
    vi.unstubAllGlobals();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("q=tee"))).toBe(true);
    expect(urls.some((u) => u.includes("providers=1"))).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.confirmation?.payload.blueprintId).toBe(6);
    expect(result.confirmation?.payload.printProviderId).toBe(30);
    expect(result.confirmation?.payload.variantIds).toEqual([11, 12]);
    expect(result.confirmation?.payload.price).toBe(2499);
    expect(result.confirmation?.payload.tags).toEqual(["cat", "gift"]);
    expect(await db.productDrafts.count()).toBe(0);
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
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            configured: true,
            variants: [
              { id: 1, available: true, placeholders: [{ position: "front" }] },
              { id: 2, available: true, placeholders: [{ position: "front" }] },
              { id: 3, available: false, placeholders: [{ position: "front" }] },
            ],
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`provider=99`);
    expect(result.error).toBeUndefined();
    expect(result.confirmation?.payload.variantIds).toEqual([1, 2]);
    expect(result.confirmation?.payload.printArea).toBe("front");
    expect(result.confirmation?.payload.price).toBe(1999);
    expect(await db.productDrafts.count()).toBe(0);
  });

  it("caps the proposed selection at Printify's 100-variant limit", async () => {
    await db.designs.put({
      id: "d1",
      name: "Sunset",
      tags: [],
      originalAssetId: "a1",
      activeVariant: "main",
      createdAt: 1,
      updatedAt: 1,
    });
    const many = Array.from({ length: 130 }, (_, i) => ({
      id: i + 1,
      available: true,
      placeholders: [{ position: "front" }],
    }));
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ configured: true, variants: many }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
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
    const variantIds = result.confirmation?.payload.variantIds as number[];
    expect(variantIds).toHaveLength(100);
    expect(variantIds[99]).toBe(100);
    expect(result.confirmation?.detail).toContain("caps a product at 100 variants");
  });

  it("reports an unknown tool instead of guessing", async () => {
    const result = await executeTool("delete_everything", {});
    expect(result.error).toContain("No tool named");
  });
});

describe("mockup + library tools", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  async function seedLibrary() {
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
      name: "Tee mockup",
      category: "tshirt",
      tags: [],
      favorite: false,
      assetId: "a2",
      width: 100,
      height: 100,
      source: "user",
      createdAt: 1,
    });
  }

  it("lists designs from the local library", async () => {
    await seedLibrary();
    const all = await executeTool("list_library", {});
    expect((all.result as { items: unknown[] }).items).toHaveLength(1);
    const filtered = await executeTool("list_library", { kind: "designs", query: "nope" });
    expect((filtered.result as { items: unknown[] }).items).toHaveLength(0);
  });

  it("browses the Printify catalog by query", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ configured: true, blueprints: [{ id: 6, title: "Tee", brand: "G" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeTool("browse_printify_catalog", { query: "mug" });
    vi.unstubAllGlobals();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("q=mug");
    expect(result.error).toBeUndefined();
    expect((result.result as { blueprints: unknown[] }).blueprints).toHaveLength(1);
  });

  it("proposes a single mockup render without writing anything", async () => {
    await seedLibrary();
    const result = await executeTool("create_mockup_render", { design: "sunset" });
    expect(result.error).toBeUndefined();
    expect(result.confirmation?.payload.designId).toBe("d1");
    expect(result.confirmation?.payload.mockupId).toBe("m1");
    expect(await db.assets.where("kind").equals("mockup-render").count()).toBe(0);
  });

  it("errors when confirming a mockup render whose blobs are missing", async () => {
    await seedLibrary();
    const result = await confirmMockupRender({ designId: "d1", mockupId: "m1", ink: "main" });
    expect(result.error).toBeDefined();
  });

  it("saves a placement and a template on confirm", async () => {
    await seedLibrary();
    const proposal = await executeTool("save_placement", {
      design: "sunset",
      mockup: "tee",
      transform: { x: 2, y: 0.5, scale: 0.4 },
      asTemplate: true,
      templateName: "Chest print",
    });
    expect(proposal.confirmation).toBeDefined();
    const executed = await confirmSavePlacement(proposal.confirmation!.payload);
    expect(executed.error).toBeUndefined();
    const placement = await db.placements.where("designId").equals("d1").first();
    expect(placement?.transform.x).toBe(1);
    expect(await db.templates.count()).toBe(1);
  });

  it("proposes an ink variant and reports missing artwork on confirm", async () => {
    await seedLibrary();
    const proposal = await executeTool("create_ink_variant", { design: "sunset", ink: "black" });
    expect(proposal.confirmation?.payload.ink).toBe("black");
    const executed = await confirmInkVariant({ designId: "d1", ink: "black" });
    expect(executed.error).toBeDefined();
  });

  it("proposes background removal and reports missing artwork on confirm", async () => {
    await seedLibrary();
    const proposal = await executeTool("remove_background", { design: "sunset", engine: "flood-key" });
    expect(proposal.confirmation?.payload.engine).toBe("flood-key");
    const executed = await confirmRemoveBackground({ designId: "d1", engine: "flood-key" });
    expect(executed.error).toBeDefined();
  });

  it("needs an attached image before saving one from chat", async () => {
    const none = await executeTool("save_chat_image", { kind: "design" });
    expect(none.error).toBeDefined();
    const withImage = await executeTool(
      "save_chat_image",
      { kind: "design", name: "New art" },
      { attachments: [{ name: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAAA" }] },
    );
    expect(withImage.confirmation?.payload.name).toBe("New art");
    const missing = await confirmSaveChatImage({ kind: "design" }, { attachments: [] });
    expect(missing.error).toBeDefined();
  });

  it("registers a confirm runner for every writing tool", () => {
    for (const name of [
      "create_batch_job",
      "create_mockup_render",
      "save_placement",
      "create_ink_variant",
      "remove_background",
      "save_chat_image",
      "create_printify_product",
    ]) {
      expect(CONFIRM_TOOL_RUNNERS[name], name).toBeTypeOf("function");
    }
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
