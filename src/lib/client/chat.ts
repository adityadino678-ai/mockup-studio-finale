"use client";

// ---------------------------------------------------------------------------
// Agent chat — browser-side store + streaming client.
//
// Transcripts live only in this origin's IndexedDB. Sending a prompt posts the
// message history to `/api/ai/chat`, which streams SSE frames back; we parse
// them with the shared SseParser and surface deltas/reasoning to the caller.
// Nothing is persisted on the server.
// ---------------------------------------------------------------------------

import { db, getSetting, setSetting } from "@/lib/db/schema";
import { authedFetch } from "@/lib/client/integrations";
import { SseParser, decodeSseData, type SseFrame } from "@/lib/ai/sse";
import type { ChatMessage, ChatRole, Conversation, MessagePart } from "@/types/domain";

export type ApiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ApiMessage {
  role: ChatRole;
  content: string | ApiContentPart[];
}

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function createConversation(
  provider: string,
  model: string,
  title = "New chat",
): Promise<Conversation> {
  const now = Date.now();
  const conversation: Conversation = {
    id: newId(),
    title,
    provider,
    model,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  await db.conversations.add(conversation);
  return conversation;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) return;
  await db.conversations.update(id, { title: clean, updatedAt: Date.now() });
}

export async function setConversationPinned(id: string, pinned: boolean): Promise<void> {
  await db.conversations.update(id, { pinned });
}

export async function touchConversation(id: string, patch: Partial<Conversation> = {}): Promise<void> {
  await db.conversations.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteConversation(id: string): Promise<void> {
  await db.transaction("rw", db.conversations, db.messages, async () => {
    await db.messages.where("conversationId").equals(id).delete();
    await db.conversations.delete(id);
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function addMessage(
  conversationId: string,
  role: ChatRole,
  parts: MessagePart[],
  meta: { provider?: string; model?: string } = {},
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: newId(),
    conversationId,
    role,
    parts,
    ...meta,
    createdAt: Date.now(),
  };
  await db.messages.add(message);
  return message;
}

/** Flattens stored messages into the `{role, content}` shape the API expects. */
export function toApiMessages(messages: ChatMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    const images = message.parts.filter(
      (p): p is { type: "image"; image: { name: string; mime: string; dataUrl: string } } =>
        p.type === "image",
    );
    if (images.length > 0) {
      const content: ApiContentPart[] = [];
      if (text) content.push({ type: "text", text });
      for (const p of images) content.push({ type: "image_url", image_url: { url: p.image.dataUrl } });
      out.push({ role: message.role, content });
      continue;
    }
    if (text) out.push({ role: message.role, content: text });
  }
  return out;
}

/** Rough token estimate (≈4 chars/token). The UI labels this as approximate. */
export function estimateTokens(text: string): number {
  return text.trim() ? Math.ceil(text.length / 4) : 0;
}

export function messageTokens(message: ChatMessage): number {
  return message.parts.reduce((sum, part) => {
    if (part.type === "text" || part.type === "reasoning") return sum + estimateTokens(part.text);
    return sum;
  }, 0);
}

// ---------------------------------------------------------------------------
// Favorite models (`provider/model` keys, stored per browser)
// ---------------------------------------------------------------------------

const FAVORITES_KEY = "ai:favorites";

export async function loadFavorites(): Promise<string[]> {
  const list = await getSetting<string[]>(FAVORITES_KEY, []);
  return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}

export async function saveFavorites(list: string[]): Promise<void> {
  await setSetting(FAVORITES_KEY, list);
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface StreamCallbacks {
  onDelta?(text: string): void;
  onReasoning?(text: string): void;
  onUsage?(usage: Record<string, unknown>): void;
}

export interface StreamResult {
  text: string;
  reasoning: string;
  firstTokenMs?: number;
  tokensPerSecond?: number;
  aborted: boolean;
  error?: string;
}

function applyFrame(
  frame: SseFrame,
  result: StreamResult,
  callbacks: StreamCallbacks,
  startedAt: number,
): boolean {
  if (frame.event === "done") return true;
  const data = decodeSseData<Record<string, unknown>>(frame);
  if (frame.event === "delta" && typeof data?.text === "string") {
    if (result.firstTokenMs === undefined) result.firstTokenMs = Date.now() - startedAt;
    result.text += data.text;
    callbacks.onDelta?.(data.text);
  } else if (frame.event === "reasoning" && typeof data?.text === "string") {
    result.reasoning += data.text;
    callbacks.onReasoning?.(data.text);
  } else if (frame.event === "usage" && data) {
    callbacks.onUsage?.(data);
  } else if (frame.event === "error") {
    result.error = (data?.message as string) ?? "The provider stopped the response.";
  }
  return false;
}

/** Parses an SSE `Response` body into a `StreamResult`, dispatching callbacks. */
export async function consumeStream(res: Response, callbacks: StreamCallbacks = {}): Promise<StreamResult> {
  const result: StreamResult = { text: "", reasoning: "", aborted: false };
  const startedAt = Date.now();
  if (!res.body) return { ...result, error: "The provider returned no response stream." };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let done = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        if (applyFrame(frame, result, callbacks, startedAt)) {
          done = true;
          break;
        }
      }
      if (done) break;
    }
    if (!done) for (const frame of parser.flush()) applyFrame(frame, result, callbacks, startedAt);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") result.aborted = true;
    else result.error = error instanceof Error ? error.message : "Stream failed";
  }

  const elapsedMs = Date.now() - startedAt;
  if (result.text && elapsedMs > 0) {
    result.tokensPerSecond = Math.round((estimateTokens(result.text) / elapsedMs) * 1000 * 10) / 10;
  }
  return result;
}

/** Posts message history to `/api/ai/chat` and streams the reply. */
export async function streamReply(
  messages: ApiMessage[],
  options: { effort?: string; signal?: AbortSignal } & StreamCallbacks = {},
): Promise<StreamResult> {
  const res = await authedFetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, effort: options.effort }),
    signal: options.signal,
  });

  if (!res.ok) {
    let message = `The provider returned HTTP ${res.status}.`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* keep the default */
    }
    return { text: "", reasoning: "", aborted: false, error: message };
  }

  return consumeStream(res, options);
}
