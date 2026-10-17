// ---------------------------------------------------------------------------
// Agent tools — the small, honest set of actions the chat agent can really run.
//
// This module is isomorphic (no DOM, no server-only imports): the browser uses
// it to build the tool schemas sent to the provider and to decide what needs a
// confirmation, and the server uses the same definitions when it forwards the
// tool list. Tools marked `confirm` write to the local database and must be
// approved by the user before anything is created.
// ---------------------------------------------------------------------------

export interface OpenAiToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True when invoking the tool writes to IndexedDB and needs confirmation. */
  confirm?: boolean;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "explain_howto",
    description:
      "Explain how to do something inside Mockup Studio (uploading, the editor, batches, background removal, templates, exports, products, listings, SEO). Read-only.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The workflow or feature the user is asking about." },
      },
      required: ["topic"],
    },
  },
  {
    name: "summarize_workspace",
    description:
      "Read the counts of the user's local library (designs, mockups, batch jobs, exports, listing drafts) and report them. Read-only.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "draft_listing",
    description:
      "Draft Etsy listing copy (keyword ideas, title drafts, description, tags) for a print-on-demand concept. Returns editable ideas; fabricates no search volume or sales data.",
    parameters: {
      type: "object",
      properties: {
        concept: { type: "string", description: "The niche or product concept to write copy for." },
        audience: { type: "string", description: "Optional target audience." },
        keywords: { type: "string", description: "Optional seed keyword or phrase." },
      },
      required: ["concept"],
    },
  },
  {
    name: "create_batch_job",
    description:
      "Propose a batch render job across the user's designs and mockups. This only prepares the job — nothing is created until the user confirms.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        designs: {
          type: "array",
          items: { type: "string" },
          description: "Design names to include. Omit to use every design.",
        },
        mockups: {
          type: "array",
          items: { type: "string" },
          description: "Mockup names to include. Omit to use every mockup.",
        },
        variant: {
          type: "string",
          enum: ["main", "white", "black"],
          description: "Ink variant to apply. Defaults to main.",
        },
        skipExisting: {
          type: "boolean",
          description: "Skip combinations that already have a render. Defaults to true.",
        },
      },
      required: [],
    },
  },
  {
    name: "create_printify_product",
    description:
      "Propose a real Printify product from one of the user's designs. Requires a blueprint id (product type), a print provider id, and a price in cents. Ask the user for any missing value or send them to the Product Builder to choose it — never invent ids. Nothing is uploaded or created until the user confirms.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        design: {
          type: "string",
          description: "Name of the design to use as the artwork. Omit to use the first design.",
        },
        blueprintId: {
          type: "number",
          description: "Printify blueprint id for the product type (e.g. 6 for a t-shirt).",
        },
        printProviderId: {
          type: "number",
          description: "Printify print provider id for that blueprint.",
        },
        price: {
          type: "number",
          description: "Price in integer cents applied to every variant (e.g. 1999 for $19.99).",
        },
        title: { type: "string", description: "Optional product title. Defaults to the design name." },
        description: { type: "string", description: "Optional product description." },
      },
      required: [],
    },
  },
];

const BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);

export function agentTool(name: string): AgentTool | undefined {
  return BY_NAME.get(name);
}

/** Builds the OpenAI-style tool list for the subset of names the model supports. */
export function toOpenAiTools(names: string[]): OpenAiToolDef[] {
  const out: OpenAiToolDef[] = [];
  for (const name of names) {
    const tool = BY_NAME.get(name);
    if (tool) {
      out.push({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      });
    }
  }
  return out;
}

/** Tolerantly parses the JSON arguments string a model emits for a tool call. */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Intent router (fallback)
//
// Some models — and many free ones — answer in prose without ever emitting a
// tool call. This keyword router lets the client run the obvious tool anyway so
// the agent still acts, instead of only talking. Order matters: action-like
// intents are checked before the generic how-to intent.
// ---------------------------------------------------------------------------

export interface RoutedIntent {
  name: string;
  args: Record<string, unknown>;
}

const INTENT_RULES: Array<{ name: string; patterns: RegExp[] }> = [
  {
    name: "create_printify_product",
    patterns: [
      /\bprintify\b[^.?!]*\b(product|listing|item)\b/i,
      /\b(create|make|list|publish|send|upload)\b[^.?!]*\bprintify\b/i,
      /\b(list|publish) (it|this|my design|the design)\b/i,
    ],
  },
  {
    name: "create_batch_job",
    patterns: [
      /\b(batch|bulk)\b/i,
      /\bgenerate (all|every|the|my)\b/i,
      /\bcombine (all|every|my)\b/i,
      /\brender (all|every|my)\b/i,
      /\bcreate (a )?(batch|job|jobs)\b/i,
    ],
  },
  {
    name: "draft_listing",
    patterns: [
      /\b(listing|titles?|descriptions?|tags?|etsy|seo|keyword)\b/i,
      /\b(write|draft|brainstorm) (me )?(copy|listing)\b/i,
    ],
  },
  {
    name: "summarize_workspace",
    patterns: [
      /\b(how many|count my|overview of my|summar(y|ise|ize))\b/i,
      /\bwhat('?s| is) in my (library|workspace|store)\b/i,
      /\bmy (designs|mockups|library|workspace|exports|listings)\b/i,
    ],
  },
  {
    name: "explain_howto",
    patterns: [
      /\bhow (do|can|should|would) i\b/i,
      /\bhow to\b/i,
      /\bwhere (do|can) i\b/i,
      /\bwalk me through\b/i,
      /\bexplain how\b/i,
      /\bguide me\b/i,
    ],
  },
];

/**
 * Maps a user message to the tool that most obviously serves it, or null when
 * nothing matches. Used only when the model itself requested no tool.
 */
export function routeIntent(text: string): RoutedIntent | null {
  const clean = (text ?? "").trim();
  if (!clean) return null;
  for (const rule of INTENT_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(clean))) continue;
    if (rule.name === "explain_howto") return { name: rule.name, args: { topic: clean.slice(0, 200) } };
    if (rule.name === "draft_listing") return { name: rule.name, args: { concept: clean.slice(0, 200) } };
    return { name: rule.name, args: {} };
  }
  return null;
}
