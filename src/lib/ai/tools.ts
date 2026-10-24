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
      "Explain how to do something inside Mockup Studio (uploading, placing artwork, print areas, mockup renders, batches, background removal, ink variants, exports, Printify products, listing copy). Read-only.",
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
    name: "list_library",
    description:
      "List the user's designs or mockups by name (id + name), optionally filtered. Read-only. Use it to find the exact name of a design or mockup before an action.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["designs", "mockups"],
          description: "Which library to list. Defaults to designs.",
        },
        query: { type: "string", description: "Optional case-insensitive filter on the name." },
      },
      required: [],
    },
  },
  {
    name: "browse_printify_catalog",
    description:
      "Look up the live Printify catalog. Read-only. Pass query (e.g. \"t-shirt\") to search product types, blueprintId to list its print providers, or blueprintId + printProviderId to list variants (sizes/colors + print areas). Use it when the user wants to see options before creating a product.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product-type keywords, e.g. \"t-shirt\" or \"mug\"." },
        blueprintId: { type: "number", description: "A Printify blueprint id to inspect." },
        printProviderId: { type: "number", description: "A print provider id for that blueprint." },
      },
      required: [],
    },
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
    name: "create_mockup_render",
    description:
      "Make a single mockup: composite one design onto one mockup photo. Uses the mockup's print area and the Printify Studio placement when it has one; otherwise uses the saved placement (or a default). This prepares the render — nothing is created until the user confirms.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        design: { type: "string", description: "Design name to place. Omit to use the first design." },
        mockup: { type: "string", description: "Mockup name to use. Omit to use the first mockup." },
        ink: {
          type: "string",
          enum: ["main", "white", "black"],
          description: "Which artwork variant to place. Defaults to main.",
        },
        behindMockup: {
          type: "boolean",
          description: "Draw the design behind a transparent mockup PNG. Defaults to the saved setting.",
        },
      },
      required: [],
    },
  },
  {
    name: "save_placement",
    description:
      "Save where a design sits on a mockup. When the mockup has a print area this writes the Printify Studio placement inside that area (the same placement the Studio and every render use); otherwise it writes the mockup transform. Optionally also save it as a reusable placement template. Nothing is written until the user confirms.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        design: { type: "string", description: "Design name. Omit to use the first design." },
        mockup: { type: "string", description: "Mockup name. Omit to use the first mockup." },
        transform: {
          type: "object",
          description:
            "Placement as fractions: { x, y, scale, rotation, flipX, flipY, opacity, stretch }. x/y/scale are 0..1 fractions of the mockup.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            scale: { type: "number" },
            rotation: { type: "number" },
            flipX: { type: "boolean" },
            flipY: { type: "boolean" },
            opacity: { type: "number" },
            stretch: { type: "number" },
          },
        },
        asTemplate: { type: "boolean", description: "Also save this placement as a reusable template." },
        templateName: { type: "string", description: "Name for the template when asTemplate is true." },
      },
      required: [],
    },
  },
  {
    name: "create_ink_variant",
    description:
      "Generate a white-ink or black-ink version of a design (alpha-preserving recolor). The original is kept. Nothing is created until the user confirms.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        design: { type: "string", description: "Design name. Omit to use the first design." },
        ink: {
          type: "string",
          enum: ["white", "black"],
          description: "Which ink color to generate. Defaults to white.",
        },
      },
      required: [],
    },
  },
  {
    name: "remove_background",
    description:
      "Remove the background from a design. It runs on this device: the flood key removes one flat colour, then the border model handles a backdrop that fades or vignettes. No key, no upload, no limit. The original is kept. Nothing is created until the user confirms.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        design: { type: "string", description: "Design name. Omit to use the first design." },
        tolerance: {
          type: "number",
          description: "Color tolerance for both local engines (5–120). Defaults to the app default.",
        },
      },
      required: [],
    },
  },
  {
    name: "save_chat_image",
    description:
      "Save an image the user attached in this chat as a new design or mockup in their local library. Nothing is written until the user confirms.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["design", "mockup"],
          description: "Save it as a design (artwork) or a mockup (product photo). Defaults to design.",
        },
        name: { type: "string", description: "Optional name. Defaults to the attached file name." },
        index: { type: "number", description: "Which attached image to use (0-based). Defaults to the first." },
        category: {
          type: "string",
          description: "Mockup category when kind is mockup (tshirt, hoodie, mug, poster, tote, sticker, other).",
        },
      },
      required: [],
    },
  },
  {
    name: "create_printify_product",
    description:
      "Create a real Printify product from one of the user's designs. Give a productType (e.g. \"t-shirt\", \"hoodie\", \"mug\") and it finds the blueprint, print provider and variants itself. Optionally pass blueprintId/printProviderId, a price, tags, and variant filters for control. Nothing is uploaded or created until the user confirms.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        design: {
          type: "string",
          description: "Name of the design to use as the artwork. Omit to use the first design.",
        },
        productType: {
          type: "string",
          description: "Product type to list, e.g. \"t-shirt\", \"hoodie\", \"mug\", \"poster\". Used to resolve the blueprint when blueprintId is omitted.",
        },
        blueprintId: {
          type: "number",
          description: "Optional explicit Printify blueprint id (overrides productType resolution).",
        },
        printProviderId: {
          type: "number",
          description: "Optional explicit print provider id. Omit to let the agent pick one that has variants.",
        },
        price: {
          type: "number",
          description: "Price in integer cents for every variant (e.g. 1999 for $19.99). Defaults to a standard price when omitted.",
        },
        prices: {
          type: "object",
          description: "Optional per-variant price overrides in cents, keyed by variant id.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Listing tags for the product.",
        },
        variantFilters: {
          type: "object",
          description:
            "Optional subset selection, e.g. { colors: [\"Black\",\"White\"], sizes: [\"M\",\"L\"] }. Omit to enable the first 100 available variants.",
          properties: {
            colors: { type: "array", items: { type: "string" } },
            sizes: { type: "array", items: { type: "string" } },
          },
        },
        ink: {
          type: "string",
          enum: ["main", "white", "black"],
          description: "Which artwork variant to upload. Defaults to main.",
        },
        printArea: {
          type: "string",
          description: "Print area position to attach the artwork to (e.g. front). Defaults to the first available.",
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
      /(^|[.!?]\s*)(create|make|run|start|generate|build)\b[^.?!]*\b(batch|bulk)\b/i,
      /\b(batch|bulk)\b[^.?!]*\b(render|generate|create|job|jobs|them|it)\b/i,
      /\bgenerate (all|every|the|my)\b/i,
      /\bcombine (all|every|my)\b/i,
      /\brender (all|every|my)\b/i,
      /\bcreate (a )?(batch|job|jobs)\b/i,
    ],
  },
  {
    name: "create_mockup_render",
    patterns: [
      /(^|[.!?]\s*)(make|create|render|put|compose|place)\b[^.?!]*\bmockups?\b/i,
      /(^|[.!?]\s*)(make|render|put|place)\b[^.?!]*\bon (the )?(mockup|shirt|tee|hoodie|mug|poster|tote)\b/i,
    ],
  },
  {
    name: "create_ink_variant",
    patterns: [
      /(^|[.!?]\s*)(make|create|generate|add|convert)\b[^.?!]*\b(white|black)[ -]?ink\b/i,
      /(^|[.!?]\s*)\b(white|black)[ -]ink (variant|version)\b/i,
    ],
  },
  {
    name: "remove_background",
    patterns: [
      /(^|[.!?]\s*)(remove|delete|cut out|erase)\b[^.?!]*\b(background|bg)\b/i,
      /(^|[.!?]\s*)\bcut ?out\b/i,
    ],
  },
  {
    name: "save_chat_image",
    patterns: [
      /(^|[.!?]\s*)(save|use|add)\b[^.?!]*\b(this|the|attached|my)\b[^.?!]*\b(image|picture|photo|attachment)\b/i,
    ],
  },
  {
    name: "save_placement",
    patterns: [/(^|[.!?]\s*)(save|set|remember)\b[^.?!]*\bplacement\b/i],
  },
  {
    name: "browse_printify_catalog",
    patterns: [
      /\b(browse|show|search|find|what)\b[^.?!]*\b(printify|catalog|blueprint|product type|print provider)s?\b/i,
    ],
  },
  {
    name: "list_library",
    patterns: [/(^|[.!?]\s*)(list|show)\b[^.?!]*\b(designs?|mockups?)\b/i],
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

/** Product words the router recognises so a fallback listing has a real type. */
const PRODUCT_WORDS = [
  "t-shirt",
  "tshirt",
  "tee shirt",
  "tee",
  "shirt",
  "hoodie",
  "sweatshirt",
  "mug",
  "poster",
  "tote",
  "bag",
  "sticker",
  "hat",
  "cap",
  "leggings",
  "phone case",
  "notebook",
  "blanket",
  "pillow",
  "canvas",
];

function detectProductType(text: string): string {
  const lower = text.toLowerCase();
  return PRODUCT_WORDS.find((word) => lower.includes(word)) ?? "";
}

function detectPriceCents(text: string): number | undefined {
  const match = text.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
  if (!match) return undefined;
  const cents = Math.round(Number(match[1]) * 100);
  return cents > 0 ? cents : undefined;
}

/**
 * Maps a user message to the tool that most obviously serves it, or null when
 * nothing matches. Used only when the model itself requested no tool.
 */
export function routeIntent(text: string): RoutedIntent | null {
  const clean = (text ?? "").trim();
  if (!clean) return null;
  // A "how…" question wants an explanation, never a write. Check this before
  // the action rules so "How do I publish my design to Printify?" explains
  // instead of proposing a real product.
  if (
    /(^|[.!?]\s*)how\b(?!\s+(many|much|long|often|far|old)\b)/i.test(clean) ||
    /\bwhere (do|can) i\b|\bwalk me through\b|\bexplain how\b/i.test(clean)
  ) {
    return { name: "explain_howto", args: { topic: clean.slice(0, 200) } };
  }
  for (const rule of INTENT_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(clean))) continue;
    const lower = clean.toLowerCase();
    switch (rule.name) {
      case "explain_howto":
        return { name: rule.name, args: { topic: clean.slice(0, 200) } };
      case "draft_listing":
        return { name: rule.name, args: { concept: clean.slice(0, 200) } };
      case "create_printify_product": {
        const args: Record<string, unknown> = {};
        const productType = detectProductType(clean);
        if (productType) args.productType = productType;
        const price = detectPriceCents(clean);
        if (price) args.price = price;
        return { name: rule.name, args };
      }
      case "create_ink_variant":
        return { name: rule.name, args: { ink: /\bwhite\b/i.test(lower) ? "white" : "black" } };
      case "browse_printify_catalog": {
        const query = detectProductType(clean) || clean.slice(0, 60);
        return { name: rule.name, args: { query } };
      }
      case "list_library":
        return { name: rule.name, args: { kind: /\bmockups?\b/i.test(lower) ? "mockups" : "designs" } };
      case "save_chat_image":
        return { name: rule.name, args: { kind: /\bmockups?\b/i.test(lower) ? "mockup" : "design" } };
      default:
        return { name: rule.name, args: {} };
    }
  }
  return null;
}
