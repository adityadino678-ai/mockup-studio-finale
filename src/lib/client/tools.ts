"use client";

// ---------------------------------------------------------------------------
// Agent tool execution (browser side).
//
// The model proposes a tool call; the answer must come from real data in this
// browser. Each executor below either reads IndexedDB, calls an existing
// endpoint, or prepares a proposal. Tools that write (`create_batch_job`) do
// NOT touch the database here — they return a `confirmation` and the UI runs
// the real write only after the user clicks Create.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db/schema";
import { authedFetch } from "@/lib/client/integrations";
import { artworkToBase64, MAX_ARTWORK_BYTES } from "@/lib/client/artwork";
import { createBatchJob, runBatchJob } from "@/lib/batch/runner";
import { getAssetBlob, logActivity, uid } from "@/lib/db/repo";
import type { ProductDraft } from "@/types/domain";
import type { InkVariant } from "@/types/domain";

export interface ToolConfirmation {
  /** The exact arguments to run once the user approves. */
  payload: Record<string, unknown>;
  /** Human-readable description of what will be created. */
  detail: string;
}

export interface ToolExecResult {
  /** One-line summary rendered on the collapsed tool card. */
  summary: string;
  /** Structured result replayed to the model as the tool message. */
  result?: unknown;
  /** Set when the tool proposes a write the user must confirm first. */
  confirmation?: ToolConfirmation;
  error?: string;
}

const HOWTO: Array<{ match: RegExp; answer: string }> = [
  {
    match: /upload|import|add (a )?(design|artwork|file)/i,
    answer:
      "Upload designs from the Designs page: click Upload, pick PNG/JPG files, and they are stored in this browser's IndexedDB. Mockups upload the same way on the Mockups page. Nothing is sent to a server.",
  },
  {
    match: /edit|composite|place|position|scale|rotate|canvas/i,
    answer:
      "Open a design, choose a mockup, and the editor loads with the Konva canvas. Drag to move, use the handles to scale/rotate, and Save to store the transform. Saving writes a placement template you can reuse.",
  },
  {
    match: /batch|generate (all|every)|combinations|render all/i,
    answer:
      "Batch Studio generates every design × mockup combination. Pick the designs and mockups, choose an ink variant rule, set concurrency, then Run. Existing renders can be skipped so re-runs are cheap.",
  },
  {
    match: /background|remove bg|cutout|transparen/i,
    answer:
      "Background removal runs locally: MODNet is tuned for photos, while the flood-key engine is better for flat artwork on a solid background. Pick the engine on the design's actions menu.",
  },
  {
    match: /ink|variant|white|black/i,
    answer:
      "Ink variants create white or black versions of a design without touching the original asset. Set a variant rule on a batch job, or convert a single design from its actions menu.",
  },
  {
    match: /template|placement|reuse/i,
    answer:
      "Saving a placement on the editor stores a template. Templates can be applied to other designs or selected as the rule for a batch job.",
  },
  {
    match: /export|zip|download/i,
    answer:
      "Export builds a ZIP with a manifest and the rendered images. Choose the batch job (or the whole library) and the archive is assembled in the browser.",
  },
  {
    match: /listing|etsy|title|tag|seo|keyword/i,
    answer:
      "Listing tools validate Etsy constraints (title ≤140 chars, ≤13 tags of ≤20 chars) and can draft copy with AI. Submission to Etsy is intentionally not implemented — you get validated drafts to paste.",
  },
  {
    match: /printify|product|publish/i,
    answer:
      "Create a Printify product from the Products page: pick a design, choose a blueprint and print provider, set a price, then click Create on Printify. The agent can do it too — ask it to list a design and confirm on the tool card. Pricing is required (integer cents) and the artwork is uploaded to Printify.",
  },
  {
    match: /key|settings|provider|api/i,
    answer:
      "Paste API keys in Settings → API connections. Keys live in this browser's IndexedDB and are sent per request as headers; the server never stores them.",
  },
];

function explainHowto(args: Record<string, unknown>): ToolExecResult {
  const topic = String(args.topic ?? "").trim();
  const hit = HOWTO.find((entry) => entry.match.test(topic));
  if (hit) return { summary: `Explained: ${topic || "workflow"}`, result: { topic, answer: hit.answer } };
  const overview =
    "Mockup Studio is local-first: designs, mockups, renders, templates, and exports all live in this browser's IndexedDB. Core flows are Designs (upload) → Mockups → Editor (compose + save placement) → Batch Studio (design × mockup) → Export (ZIP). AI SEO and listing drafts are optional and need a key.";
  return { summary: `Explained: ${topic || "Mockup Studio"}`, result: { topic, answer: overview } };
}

async function summarizeWorkspace(): Promise<ToolExecResult> {
  const [designs, mockups, renders, jobs, exports, listings] = await Promise.all([
    db.designs.count(),
    db.mockups.count(),
    db.assets.where("kind").equals("mockup-render").count(),
    db.batchJobs.count(),
    db.exports.count(),
    db.listingDrafts.count(),
  ]);
  const counts = { designs, mockups, renders, batchJobs: jobs, exports, listingDrafts: listings };
  const summary = `${designs} designs · ${mockups} mockups · ${renders} renders · ${jobs} batch jobs`;
  return { summary, result: counts };
}

interface SeoResponse {
  configured?: boolean;
  error?: string;
  result?: {
    keywords?: Array<{ term: string }>;
    titleDrafts?: string[];
    descriptionDraft?: string;
    tags?: string[];
    disclaimer?: string;
  };
}

async function draftListing(args: Record<string, unknown>): Promise<ToolExecResult> {
  const concept = String(args.concept ?? "").trim();
  if (!concept) return { summary: "Needed a concept to draft", error: "draft_listing needs a concept." };
  const res = await authedFetch("/api/ai/seo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      niche: concept,
      audience: args.audience ? String(args.audience) : undefined,
      seedKeyword: args.keywords ? String(args.keywords) : undefined,
    }),
  });
  const data = (await res.json().catch(() => null)) as SeoResponse | null;
  if (!res.ok || !data?.result) {
    return { summary: "Listing draft failed", error: data?.error ?? `Request failed (HTTP ${res.status}).` };
  }
  const titles = data.result.titleDrafts ?? [];
  return {
    summary: `Drafted ${titles.length} titles and ${(data.result.tags ?? []).length} tags for “${concept}”`,
    result: data.result,
  };
}

async function proposeBatchJob(args: Record<string, unknown>): Promise<ToolExecResult> {
  const allDesigns = await db.designs.toArray();
  const allMockups = await db.mockups.toArray();
  if (!allDesigns.length || !allMockups.length) {
    return {
      summary: "Nothing to batch yet",
      error: "A batch needs at least one design and one mockup in this browser.",
    };
  }

  const designNames = Array.isArray(args.designs) ? args.designs.map(String) : [];
  const mockupNames = Array.isArray(args.mockups) ? args.mockups.map(String) : [];
  const pickByName = <T extends { id: string; name: string }>(items: T[], names: string[]): T[] => {
    if (!names.length) return items;
    const wanted = names.map((n) => n.toLowerCase());
    const matched = items.filter((item) => wanted.some((n) => item.name.toLowerCase().includes(n)));
    return matched.length ? matched : items;
  };

  const designs = pickByName(allDesigns, designNames);
  const mockups = pickByName(allMockups, mockupNames);
  const variant = (["main", "white", "black"] as InkVariant[]).includes(args.variant as InkVariant)
    ? (args.variant as InkVariant)
    : "main";
  const skipExisting = args.skipExisting !== false;
  const total = designs.length * mockups.length;

  return {
    summary: `Ready to render ${total} combinations (${designs.length} designs × ${mockups.length} mockups, ${variant} ink)`,
    confirmation: {
      detail: `${designs.length} designs × ${mockups.length} mockups = ${total} renders, ${variant} ink${
        skipExisting ? ", skipping existing renders" : ""
      }.`,
      payload: {
        name: `Agent batch — ${designs.length}×${mockups.length}`,
        designIds: designs.map((d) => d.id),
        mockupIds: mockups.map((m) => m.id),
        variant,
        skipExisting,
        total,
      },
    },
  };
}

interface BlueprintDetailResponse {
  configured?: boolean;
  error?: string;
  blueprint?: {
    id: number;
    title: string;
    variants?: Array<{ id: number; title?: string; available?: boolean }>;
    print_areas?: Array<{ id: string; title?: string }>;
  };
}

async function proposePrintifyProduct(args: Record<string, unknown>): Promise<ToolExecResult> {
  const designs = await db.designs.toArray();
  if (!designs.length) {
    return { summary: "No designs to list", error: "Upload a design first, then I can list it on Printify." };
  }
  const wanted = String(args.design ?? "").trim().toLowerCase();
  const design =
    (wanted && designs.find((d) => d.name.toLowerCase().includes(wanted))) || designs[0];

  const blueprintId = Math.trunc(Number(args.blueprintId)) || 0;
  const printProviderId = Math.trunc(Number(args.printProviderId)) || 0;
  const price = Math.round(Number(args.price)) || 0;
  if (!blueprintId) {
    return {
      summary: "Blueprint needed",
      error:
        "A Printify blueprint (product type) id is required. Pick one in Product Builder → Create product draft, then ask again.",
    };
  }
  if (!printProviderId) {
    return {
      summary: "Print provider needed",
      error: "A Printify print provider id is required for that blueprint. Choose one in Product Builder, then ask again.",
    };
  }
  if (!(price > 0)) {
    return { summary: "Price needed", error: "Set a price in integer cents (e.g. 1999 for $19.99)." };
  }

  const res = await authedFetch(`/api/printify/catalog?id=${blueprintId}`);
  const data = (await res.json().catch(() => null)) as BlueprintDetailResponse | null;
  if (!res.ok || !data?.blueprint) {
    return {
      summary: "Could not load that blueprint",
      error: data?.error ?? `Printify catalog request failed (HTTP ${res.status}).`,
    };
  }
  const variants = (data.blueprint.variants ?? []).filter((v) => v.available !== false);
  if (!variants.length) {
    return { summary: "No variants on that blueprint", error: "That blueprint has no available variants." };
  }
  const printArea = data.blueprint.print_areas?.[0]?.id ?? "front";
  const title = String(args.title ?? "").trim() || design.name;

  return {
    summary: `Ready to create “${title}” on Printify at $${(price / 100).toFixed(2)}`,
    confirmation: {
      detail: `${variants.length} variants · $${(price / 100).toFixed(2)} each · blueprint ${blueprintId} · provider ${printProviderId} · artwork: ${design.name}.`,
      payload: {
        designId: design.id,
        designName: design.name,
        title,
        description: String(args.description ?? "").trim(),
        blueprintId,
        printProviderId,
        price,
        variantIds: variants.map((v) => v.id),
        printArea,
      },
    },
  };
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolExecResult> {
  try {
    switch (name) {
      case "explain_howto":
        return explainHowto(args);
      case "summarize_workspace":
        return await summarizeWorkspace();
      case "draft_listing":
        return await draftListing(args);
      case "create_batch_job":
        return await proposeBatchJob(args);
      case "create_printify_product":
        return await proposePrintifyProduct(args);
      default:
        return { summary: `Unknown tool “${name}”`, error: `No tool named ${name}.` };
    }
  } catch (error) {
    return {
      summary: `${name} failed`,
      error: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
}

/** Runs a confirmed batch proposal for real: creates the job and starts it. */
export async function confirmBatchJob(payload: Record<string, unknown>): Promise<ToolExecResult> {
  const designIds = Array.isArray(payload.designIds) ? payload.designIds.map(String) : [];
  const mockupIds = Array.isArray(payload.mockupIds) ? payload.mockupIds.map(String) : [];
  const variant = (["main", "white", "black"] as InkVariant[]).includes(payload.variant as InkVariant)
    ? (payload.variant as InkVariant)
    : "main";
  const skipExisting = payload.skipExisting !== false;
  try {
    const { jobId, total, reused } = await createBatchJob({
      name: typeof payload.name === "string" ? payload.name : undefined,
      designIds,
      mockupIds,
      variantRule: variant,
      variantOverrides: {},
      concurrency: 2,
      skipExisting,
    });
    await runBatchJob(jobId);
    return {
      summary: `Created batch job with ${total} combinations (${reused} reused)`,
      result: { jobId, total, reused },
    };
  } catch (error) {
    return {
      summary: "Batch job failed to start",
      error: error instanceof Error ? error.message : "Batch job failed.",
    };
  }
}

interface CreateProductResponse {
  configured?: boolean;
  error?: string;
  product?: { id: string; title?: string; status?: string };
}

/**
 * Runs a confirmed Printify proposal for real: uploads the artwork and creates
 * the product. Writes a `ProductDraft` so the creation is visible on the
 * Products page. The user's confirm click is what triggers this — the agent
 * never creates a product on its own.
 */
export async function confirmPrintifyProduct(payload: Record<string, unknown>): Promise<ToolExecResult> {
  const designId = String(payload.designId ?? "");
  const design = designId ? await db.designs.get(designId) : undefined;
  const blueprintId = Math.trunc(Number(payload.blueprintId)) || 0;
  const printProviderId = Math.trunc(Number(payload.printProviderId)) || 0;
  const price = Math.round(Number(payload.price)) || 0;
  const variantIds = Array.isArray(payload.variantIds) ? payload.variantIds.map(Number) : [];
  const title = String(payload.title ?? "").trim() || design?.name || "Untitled product";
  const description = String(payload.description ?? "").trim();
  const printArea = String(payload.printArea ?? "front");

  if (!design) return { summary: "Design not found", error: "That design is no longer in this browser." };
  if (!blueprintId || !printProviderId || !(price > 0) || !variantIds.length) {
    return { summary: "Missing product details", error: "The proposal was incomplete; try again." };
  }

  try {
    const assetId = design.originalAssetId;
    const blob = assetId ? await getAssetBlob(assetId) : undefined;
    let artwork: { base64: string; filename: string; printAreaId: string } | undefined;
    if (blob) {
      artwork = {
        base64: await artworkToBase64(blob, MAX_ARTWORK_BYTES),
        filename: `${design.name || "artwork"}.png`,
        printAreaId: printArea,
      };
    }

    const res = await authedFetch("/api/printify/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        title,
        description: description || undefined,
        blueprintId,
        printProviderId,
        price,
        variants: { [String(blueprintId)]: variantIds },
        artwork,
      }),
    });
    const data = (await res.json().catch(() => null)) as CreateProductResponse | null;
    if (!res.ok || !data?.product?.id) {
      return {
        summary: "Printify rejected the product",
        error: data?.error ?? `Printify request failed (HTTP ${res.status}).`,
      };
    }

    const now = Date.now();
    const draft: ProductDraft = {
      id: uid(),
      name: title,
      designId: design.id,
      designAssetId: assetId ?? "",
      blueprintId,
      printProviderId,
      description: description || undefined,
      priceCents: price,
      variantSelection: { [String(blueprintId)]: variantIds },
      printAreaConfig: {},
      status: "created-remote",
      remoteProductId: data.product.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.productDrafts.put(draft);
    await logActivity("product.create", `Created Printify product “${title}”`, {
      productId: data.product.id,
      blueprintId,
      printProviderId,
      price,
    });

    return {
      summary: `Created Printify product “${title}” (${data.product.id})`,
      result: { productId: data.product.id, title, blueprintId, printProviderId, price, variants: variantIds.length },
    };
  } catch (error) {
    return {
      summary: "Printify product creation failed",
      error: error instanceof Error ? error.message : "Printify product creation failed.",
    };
  }
}
