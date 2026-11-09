"use client";

// ---------------------------------------------------------------------------
// The agent loop.
//
// This is a FRESH layer, not the old `/agent` page's loop. The differences
// that matter:
//
//  - It runs on a SURFACE (Listing details or Printify Studio), so the tool
//    set and the prompt are chosen by the page, not by the user's words.
//  - It keeps a live CHECKLIST, which is the panel's progress display.
//  - It PAUSES on a question instead of guessing: `ask_user` returns a
//    question card and the turn waits for the answer.
//  - `read_design_image` returns real pixels, which are fed back to the model
//    as image content so it can actually SEE the design.
//  - Research is bounded: at most two Etsy passes per turn.
//
// The transport is unchanged: the provider streams over SSE, the browser runs
// the tools, and the history is replayed. That part is proven by the old page
// and its tests, so it is reused rather than reinvented.
// ---------------------------------------------------------------------------

import { AGENT_TOOL_NAMES, argsLookTruncated, parseToolArguments, routeIntent } from "@/agent-tools/registry";
import { executeTool } from "@/agent-tools/runners";
import { createCallTracker, MAX_IDENTICAL_CALLS, MAX_TURN_STEPS } from "@/agent-tools/step-limits";
import { addMessage, newId, toApiMessages } from "@/lib/client/chat";
import { streamReply, type ApiMessage, type ApiToolCall } from "@/lib/client/chat";
import { db } from "@/lib/db/schema";
import type {
  AgentChecklistItem,
  ChatMessage,
  ImagePartData,
  MessagePart,
} from "@/types/domain";

/** The surface the agent is running on. */
export type AgentSurface = "listing" | "studio";

/** A question the agent asked; the turn waits until it is answered. */
export interface PendingQuestion {
  question: string;
  options: string[];
  allowCustom: boolean;
}

export interface AgentLoopEvents {
  /** The assistant's prose, streamed. */
  onDelta?(text: string): void;
  onReasoning?(text: string): void;
  /** A tool started. */
  onToolStart?(call: { id: string; name: string; args: Record<string, unknown> }): void;
  /** A tool finished (successfully or not). */
  onToolEnd?(call: {
    id: string;
    name: string;
    summary: string;
    error?: string;
  }): void;
  /** The checklist was replaced. */
  onChecklist?(items: AgentChecklistItem[]): void;
  /** The turn paused for an answer. */
  onQuestion?(question: PendingQuestion): void;
  /** The turn ended. */
  onDone?(result: { text: string; stoppedReason?: string }): void;
  onError?(message: string): void;
}

export interface AgentLoopOptions {
  conversationId: string;
  provider: string;
  model: string;
  /** Provider headers for this surface's model; they override the global one. */
  headers?: Record<string, string>;
  /** The tools this surface may use. */
  toolNames: string[];
  /** The surface description injected into the prompt. */
  context: string;
  /** The user's message that started the turn. */
  userText: string;
  /** Images attached by the user to this message. */
  attachments?: ImagePartData[];
  events: AgentLoopEvents;
  signal?: AbortSignal;
}

/** The outcome of one turn. */
export interface AgentTurnResult {
  text: string;
  /** Set when the turn paused for an answer. */
  question?: PendingQuestion;
  /** Set when the turn stopped early but can be resumed. */
  canContinue?: boolean;
  error?: string;
}

/** The tools that make the listing agent useful but are NOT safe on the Studio. */
const LISTING_TOOLS = AGENT_TOOL_NAMES;

/**
 * The Studio agent only generates images.
 *
 * The Studio page has no listing to write, and a listing write there would be
 * invisible to the user, so the Studio's tool set is deliberately empty. Its
 * job is image generation, which goes through `/api/ai/images` (see the
 * `generateImage` helper), not through a tool call.
 */
const STUDIO_TOOLS: string[] = [];

/** The tool set for a surface. */
export function toolsForSurface(surface: AgentSurface): string[] {
  return surface === "studio" ? STUDIO_TOOLS : LISTING_TOOLS;
}

/** How many Etsy research passes one turn may run. */
export const MAX_RESEARCH_PASSES = 2;

const DEFAULT_BUDGET = 2000;
const MAX_ESCALATED_BUDGET = 16000;

/**
 * Runs one turn of the agent.
 *
 * The loop is deliberately explicit about its states, because the panel has to
 * show them: streaming, running a tool, waiting for an answer, and finished.
 */
export async function runAgentTurn(options: AgentLoopOptions): Promise<AgentTurnResult> {
  const {
    conversationId,
    provider,
    model,
    headers,
    toolNames,
    context,
    userText,
    attachments = [],
    events,
    signal,
  } = options;

  const tracker = createCallTracker();
  // The bounded research budget is per turn, so it is created here and handed
  // to every tool call in this turn.
  const research = { passes: 0, max: MAX_RESEARCH_PASSES };
  let text = "";
  let turnMaxTokens = DEFAULT_BUDGET;
  let nudged = false;

  try {
    for (let step = 0; step < MAX_TURN_STEPS; step++) {
      const stored = await db.messages
        .where("conversationId")
        .equals(conversationId)
        .sortBy("createdAt");
      const apiMessages = toApiMessages(stored);

      const result = await streamReply(apiMessages, {
        effort: undefined,
        maxTokens: turnMaxTokens,
        tools: toolNames.length ? toolNames : undefined,
        context,
        headers,
        signal,
        onDelta: (t) => {
          text += t;
          events.onDelta?.(t);
        },
        onReasoning: (t) => events.onReasoning?.(t),
      });

      if (result.error) {
        events.onError?.(result.error);
        return { text, error: result.error };
      }
      if (result.aborted) return { text };

      // The model's own tool calls, or - when it asked for none on a
      // user-initiated turn - the tool the keyword router matched. This is
      // what makes weaker models act instead of only talking.
      let callsToRun = result.toolCalls ?? [];
      if (!callsToRun.length && toolNames.length && userText.trim()) {
        const intent = routeIntent(userText);
        if (intent && toolNames.includes(intent.name)) {
          callsToRun = [
            {
              id: `route_${newId()}`,
              type: "function",
              function: { name: intent.name, arguments: JSON.stringify(intent.args) },
            },
          ];
        }
      }

      const parts: MessagePart[] = [];
      if (result.reasoning.trim()) parts.push({ type: "reasoning", text: result.reasoning });
      if (result.text.trim()) parts.push({ type: "text", text: result.text });

      // A model that emits the same call with the same arguments forever is
      // not making progress. Stop, keep the history, and offer Continue.
      const stalled = callsToRun.find(
        (call) =>
          tracker.record(call.function.name, call.function.arguments) > MAX_IDENTICAL_CALLS,
      );
      if (stalled) {
        if (parts.length) await addMessage(conversationId, "assistant", parts, { provider, model });
        const message = `The agent called ${stalled.function.name} with the same arguments ${MAX_IDENTICAL_CALLS + 1} times without new information, so it stopped.`;
        events.onError?.(message);
        return { text, canContinue: true, error: message };
      }

      // Truncated tool-call JSON means the output budget cut the arguments
      // off. Retry with more room rather than treating it as an empty call.
      if (callsToRun.some((call) => argsLookTruncated(call.function.arguments))) {
        turnMaxTokens = Math.min(MAX_ESCALATED_BUDGET, Math.max(turnMaxTokens * 2, DEFAULT_BUDGET));
        continue;
      }

      const toolParts: MessagePart[] = [];
      const visionImages: ImagePartData[] = [];
      let pendingQuestion: PendingQuestion | undefined;
      let checklist: AgentChecklistItem[] | undefined;

      for (const call of callsToRun) {
        const args = parseToolArguments(call.function.arguments);
        events.onToolStart?.({ id: call.id, name: call.function.name, args });
        const exec = await executeTool(call.function.name, args, {
          attachments,
          research,
        });
        events.onToolEnd?.({
          id: call.id,
          name: call.function.name,
          summary: exec.summary,
          error: exec.error,
        });
        if (exec.checklist) {
          checklist = exec.checklist;
          events.onChecklist?.(exec.checklist);
        }
        if (exec.images?.length) visionImages.push(...exec.images);
        toolParts.push({
          type: "tool",
          call: {
            id: call.id,
            name: call.function.name,
            args,
            status: exec.error ? "error" : "done",
            summary: exec.summary,
            result: exec.result,
            error: exec.error,
          },
        });
        // A question PAUSES the turn. The user answers it, and the answer is
        // replayed as a user message, so the model continues with the answer
        // in hand. Guessing instead of asking is exactly what this prevents.
        if (exec.question) {
          pendingQuestion = exec.question;
          break;
        }
      }

      const allParts: MessagePart[] = [...parts, ...toolParts];
      if (checklist) allParts.push({ type: "checklist", items: checklist });
      if (allParts.length) {
        await addMessage(conversationId, "assistant", allParts, { provider, model });
      }

      if (pendingQuestion) {
        // The question card is its own part, so the transcript shows it and
        // the answer can be rendered next to it.
        await addMessage(
          conversationId,
          "assistant",
          [{ type: "question", question: pendingQuestion }],
          { provider, model },
        );
        events.onQuestion?.(pendingQuestion);
        return { text, question: pendingQuestion };
      }

      // Images the agent read are fed back as the next request's content, so
      // the model can actually look at the design it just read.
      if (visionImages.length) {
        await addMessage(conversationId, "user", [
          {
            type: "text",
            text: "Here is the design image you asked for. Look at it before you describe it.",
          },
          ...visionImages.map((image) => ({ type: "image" as const, image })),
        ]);
        continue;
      }

      if (callsToRun.length) continue;

      // A reasoning model can spend its whole budget thinking and never
      // answer. Retry once with more room and no reasoning hint.
      if (!result.text.trim() && result.reasoning.trim() && !nudged) {
        nudged = true;
        turnMaxTokens = Math.min(MAX_ESCALATED_BUDGET, turnMaxTokens * 2);
        continue;
      }
      if (!result.text.trim()) {
        const message = "The model returned an empty response. Try again or switch to a different model.";
        events.onError?.(message);
        return { text, error: message };
      }
      events.onDone?.({ text });
      return { text };
    }

    const message = `The agent used its ${MAX_TURN_STEPS}-step budget for this turn before finishing. Everything so far is saved — press Continue to pick up where it left off.`;
    events.onError?.(message);
    return { text, canContinue: true, error: message };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { text };
    const message = error instanceof Error ? error.message : "Something went wrong during this turn.";
    events.onError?.(message);
    return { text, error: message };
  }
}

/**
 * Records the user's answer to a paused question and resumes the turn.
 *
 * The answer is stored as a user message, so the model sees exactly what the
 * user chose.
 */
export async function answerQuestion(
  conversationId: string,
  question: PendingQuestion,
  answer: string,
): Promise<void> {
  const message: ChatMessage = {
    id: newId(),
    conversationId,
    role: "user",
    parts: [{ type: "text", text: answer }],
    createdAt: Date.now(),
  };
  await db.messages.put(message);
  // Mark the question card as answered so the transcript shows the choice.
  const stored = await db.messages.where("conversationId").equals(conversationId).toArray();
  for (const row of stored) {
    const index = row.parts.findIndex((p) => p.type === "question");
    if (index === -1) continue;
    const part = row.parts[index];
    if (part.type !== "question") continue;
    const parts = [...row.parts];
    parts[index] = { type: "question", question: part.question, answer };
    await db.messages.update(row.id, { parts });
    break;
  }
}

/** The tool names a surface exposes, as the provider's tool list. */
export function toolNamesForSurface(surface: AgentSurface): string[] {
  return toolsForSurface(surface);
}

/** Re-exported so the panel does not import the wire types from two places. */
export type { ApiMessage, ApiToolCall };
