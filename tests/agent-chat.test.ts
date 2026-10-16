import { beforeEach, describe, expect, it, vi } from "vitest";
import { SseParser, decodeSseData, encodeSse } from "@/lib/ai/sse";
import { modelCapabilities, modelReasoning } from "@/lib/ai/providers";
import { parseProviderStreamLine } from "@/lib/server/ai";
import {
  addMessage,
  consumeStream,
  createConversation,
  deleteConversation,
  estimateTokens,
  loadFavorites,
  renameConversation,
  saveFavorites,
  setConversationPinned,
  toApiMessages,
} from "@/lib/client/chat";
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
});
