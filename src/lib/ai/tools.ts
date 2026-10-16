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
