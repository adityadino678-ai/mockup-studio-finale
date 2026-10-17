"use client";

// ---------------------------------------------------------------------------
// Agent tool execution (browser side).
//
// The model proposes a tool call; the answer must come from real data in this
// browser. Each executor below either reads IndexedDB, calls an existing
// endpoint, or prepares a proposal. Tools that write do NOT touch the database
// here — they return a `confirmation` and the UI runs the real write only after
// the user clicks Create.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db/schema";
import { authedFetch } from "@/lib/client/integrations";
import { artworkToBase64, MAX_ARTWORK_BYTES } from "@/lib/client/artwork";
import { createBatchJob, renderComposition, runBatchJob } from "@/lib/batch/runner";
import {
  createDesignFromFile,
  createMockupFromFile,
  designAssetIdFor,
  designMainAssetId,
  getAssetBlob,
  getPlacement,
  logActivity,
  savePlacement,
  setInkVariantAsset,
  storeAsset,
  uid,
} from "@/lib/db/repo";
import { createInkVariantBlob } from "@/lib/canvas/compose";
import { canvasToBlob, decodeImage } from "@/lib/image/image";
import { removeBackground, type BgRemovalEngineId } from "@/lib/bg-removal/engine";
import {
  DEFAULT_TRANSFORM,
  type ImagePartData,
  type InkVariant,
  type MockupCategory,
  type ProductDraft,
  type Template,
  type Transform,
} from "@/types/domain";

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
  confirm?: boolean;
  /** Set when the tool proposes a write the user must confirm first. */
  confirmation?: ToolConfirmation;
  error?: string;
}

/** Extra browser-side context a tool may need (e.g. images attached in chat). */
export interface ToolContext {
  attachments?: ImagePartData[];
}

/** Printify rejects a product with more than this many enabled variants. */
const PRINTIFY_MAX_VARIANTS = 100;

/** Fallback price (cents) used only when the user/agent gives none. */
const DEFAULT_LISTING_PRICE = 2499;

function pickByName<T extends { id: string; name: string }>(items: T[], name: string): T | undefined {
  const wanted = (name ?? "").trim().toLowerCase();
  if (!wanted) return undefined;
  return items.find((item) => item.name.toLowerCase().includes(wanted));
}

function clampTransform(raw: unknown): Transform {
  const base = { ...DEFAULT_TRANSFORM };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const num = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  return {
    x: clamp(num(r.x, base.x), 0, 1),
    y: clamp(num(r.y, base.y), 0, 1),
    scale: clamp(num(r.scale, base.scale), 0.01, 3),
    rotation: num(r.rotation, base.rotation),
    flipX: r.flipX === true,
    flipY: r.flipY === true,
    opacity: clamp(num(r.opacity, base.opacity), 0, 1),
    stretch: clamp(num(r.stretch, base.stretch), 0.1, 5),
  };
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const tag = String(raw).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 13) break;
  }
  return out;
}

function dataUrlToFile(dataUrl: string, name: string, mime: string): File {
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const isBase64 = /;base64/i.test(header);
  const binary = isBase64 ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const safeName = name.match(/\.[a-z0-9]+$/i) ? name : `${name}.png`;
  return new File([bytes], safeName, { type: mime || "image/png" });
}

// ---------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------

const HOWTO: Array<{ match: RegExp; answer: string }> = [
  {
    match: /upload|import|add (a )?(design|artwork|file)/i,
    answer:
      "Upload designs from the Designs page: click Upload, pick PNG/JPG files, and they are stored in this browser's IndexedDB. Mockups upload the same way on the Mockups page. Nothing is sent to a server.",
  },
  {
    match: /edit|composite|place|position|scale|rotate|canvas/i,
    answer:
      "Open a design, choose a mockup, and the editor loads with the Konva canvas. Drag to move, use the handles to scale/rotate, and Save to store the transform. Saving writes a placement that can be reused.",
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
      "Saving a placement in the editor stores a template. Templates can be applied to other designs or selected as the rule for a batch job.",
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
      "Create a Printify product from the Products page: pick a design, choose a blueprint and print provider, set a price, then click Create on Printify. The agent can do it too — ask it to list a design, tell it the product type, and confirm on the tool card. Pricing is required (integer cents) and the artwork is uploaded to Printify.",
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

async function listLibrary(args: Record<string, unknown>): Promise<ToolExecResult> {
  const wantsMockups = String(args.kind ?? "designs").toLowerCase().startsWith("mock");
  const query = String(args.query ?? "").trim().toLowerCase();
  const match = (name: string) => !query || name.toLowerCase().includes(query);
  if (wantsMockups) {
    const all = await db.mockups.orderBy("name").toArray();
    const items = all
      .filter((m) => match(m.name))
      .slice(0, 50)
      .map((m) => ({ id: m.id, name: m.name, category: m.category }));
    return {
      summary: `${items.length} mockup${items.length === 1 ? "" : "s"}${query ? ` matching “${query}”` : ""}`,
      result: { kind: "mockups", items },
    };
  }
  const all = await db.designs.orderBy("name").toArray();
  const items = all
    .filter((d) => match(d.name))
    .slice(0, 50)
    .map((d) => ({ id: d.id, name: d.name, tags: d.tags }));
  return {
    summary: `${items.length} design${items.length === 1 ? "" : "s"}${query ? ` matching “${query}”` : ""}`,
    result: { kind: "designs", items },
  };
}

interface BlueprintLite {
  id: number;
  title: string;
  brand: string;
  model?: string;
  category?: string;
}

interface VariantLite {
  id: number;
  title?: string;
  available?: boolean;
  options?: Record<string, string>;
  placeholders?: Array<{ position?: string }>;
}

async function browsePrintifyCatalog(args: Record<string, unknown>): Promise<ToolExecResult> {
  const blueprintId = Math.trunc(Number(args.blueprintId)) || 0;
  const printProviderId = Math.trunc(Number(args.printProviderId)) || 0;
  const query = String(args.query ?? "").trim();
  let url = "/api/printify/catalog";
  if (blueprintId && printProviderId) url += `?id=${blueprintId}&provider=${printProviderId}`;
  else if (blueprintId) url += `?id=${blueprintId}&providers=1`;
  else if (query) url += `?q=${encodeURIComponent(query)}&limit=25`;

  const res = await authedFetch(url);
  const data = (await res.json().catch(() => null)) as {
    configured?: boolean;
    error?: string;
    blueprints?: BlueprintLite[];
    providers?: Array<{ id: number; title: string }>;
    variants?: VariantLite[];
  } | null;
  if (!res.ok) {
    return { summary: "Printify lookup failed", error: data?.error ?? `Printify request failed (HTTP ${res.status}).` };
  }
  if (Array.isArray(data?.variants)) {
    const variants = data.variants
      .filter((v) => v.available !== false)
      .slice(0, 60)
      .map((v) => ({
        id: v.id,
        title: v.title,
        options: v.options,
        areas: [...new Set((v.placeholders ?? []).map((p) => p.position).filter(Boolean))],
      }));
    return {
      summary: `${variants.length} variants for blueprint ${blueprintId} · provider ${printProviderId}`,
      result: { blueprintId, printProviderId, variants },
    };
  }
  if (Array.isArray(data?.providers)) {
    return {
      summary: `${data.providers.length} print providers for blueprint ${blueprintId}`,
      result: { blueprintId, providers: data.providers },
    };
  }
  if (Array.isArray(data?.blueprints)) {
    const blueprints = data.blueprints.slice(0, 25).map((b) => ({
      id: b.id,
      title: b.title,
      brand: b.brand,
      category: b.category,
    }));
    return {
      summary: `${blueprints.length} product types${query ? ` for “${query}”` : ""}`,
      result: { query, blueprints },
    };
  }
  return { summary: "No catalog data", error: "Printify returned an unexpected response." };
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

// ---------------------------------------------------------------------------
// Batch job (proposal + real write)
// ---------------------------------------------------------------------------

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
  const pickAll = <T extends { id: string; name: string }>(items: T[], names: string[]): T[] => {
    if (!names.length) return items;
    const wanted = names.map((n) => n.toLowerCase());
    const matched = items.filter((item) => wanted.some((n) => item.name.toLowerCase().includes(n)));
    return matched.length ? matched : items;
  };

  const designs = pickAll(allDesigns, designNames);
  const mockups = pickAll(allMockups, mockupNames);
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

// ---------------------------------------------------------------------------
// Single mockup render (proposal + real write)
// ---------------------------------------------------------------------------

async function proposeMockupRender(args: Record<string, unknown>): Promise<ToolExecResult> {
  const designs = await db.designs.toArray();
  const mockups = await db.mockups.toArray();
  if (!designs.length) return { summary: "No designs to place", error: "Upload a design first." };
  if (!mockups.length) return { summary: "No mockups to use", error: "Upload a mockup first." };
  const design = pickByName(designs, String(args.design ?? "")) ?? designs[0];
  const mockup = pickByName(mockups, String(args.mockup ?? "")) ?? mockups[0];
  const ink = (["main", "white", "black"] as InkVariant[]).includes(args.ink as InkVariant)
    ? (args.ink as InkVariant)
    : "main";
  const behindMockup = args.behindMockup === true;
  return {
    summary: `Ready to place “${design.name}” on “${mockup.name}” (${ink} ink)`,
    confirmation: {
      detail: `Composite “${design.name}” onto “${mockup.name}” with its saved placement (or the default), ${ink} ink${
        behindMockup ? ", drawn behind the mockup" : ""
      }.`,
      payload: {
        designId: design.id,
        designName: design.name,
        mockupId: mockup.id,
        mockupName: mockup.name,
        ink,
        behindMockup,
      },
    },
  };
}

/** Runs a confirmed single-mockup proposal: composes and stores one render. */
export async function confirmMockupRender(payload: Record<string, unknown>): Promise<ToolExecResult> {
  const designId = String(payload.designId ?? "");
  const mockupId = String(payload.mockupId ?? "");
  const design = designId ? await db.designs.get(designId) : undefined;
  const mockup = mockupId ? await db.mockups.get(mockupId) : undefined;
  if (!design || !mockup) {
    return { summary: "Design or mockup missing", error: "That design or mockup is no longer in this browser." };
  }
  const ink = (["main", "white", "black"] as InkVariant[]).includes(payload.ink as InkVariant)
    ? (payload.ink as InkVariant)
    : "main";
  const saved = await getPlacement(designId, mockupId);
  const transform = saved?.transform ?? { ...DEFAULT_TRANSFORM };
  const behindMockup = payload.behindMockup === true || saved?.behindMockup === true;
  try {
    const assetId = await renderComposition({
      designId,
      mockupId,
      designAssetId: designAssetIdFor(design, ink),
      transform,
      behindMockup,
    });
    await logActivity("batch.item", `Agent made a mockup: “${design.name}” on “${mockup.name}”`, { assetId });
    return {
      summary: `Made “${design.name}” on “${mockup.name}”`,
      result: { assetId, designId, mockupId, ink },
    };
  } catch (error) {
    return { summary: "Mockup render failed", error: error instanceof Error ? error.message : "Render failed." };
  }
}

// ---------------------------------------------------------------------------
// Save placement (proposal + real write)
// ---------------------------------------------------------------------------

async function proposeSavePlacement(args: Record<string, unknown>): Promise<ToolExecResult> {
  const designs = await db.designs.toArray();
  const mockups = await db.mockups.toArray();
  if (!designs.length || !mockups.length) {
    return { summary: "Nothing to place", error: "A design and a mockup are both needed." };
  }
  const design = pickByName(designs, String(args.design ?? "")) ?? designs[0];
  const mockup = pickByName(mockups, String(args.mockup ?? "")) ?? mockups[0];
  const transform = clampTransform(args.transform);
  const asTemplate = args.asTemplate === true;
  const templateName = String(args.templateName ?? "").trim() || `${design.name} placement`;
  return {
    summary: `Ready to save where “${design.name}” sits on “${mockup.name}”`,
    confirmation: {
      detail: `Save the placement for “${design.name}” on “${mockup.name}”${
        asTemplate ? ` and a template named “${templateName}”` : ""
      }.`,
      payload: {
        designId: design.id,
        designName: design.name,
        mockupId: mockup.id,
        mockupName: mockup.name,
        transform,
        asTemplate,
        templateName,
      },
    },
  };
}

/** Runs a confirmed placement proposal: writes the placement (and optional template). */
export async function confirmSavePlacement(payload: Record<string, unknown>): Promise<ToolExecResult> {
  const designId = String(payload.designId ?? "");
  const mockupId = String(payload.mockupId ?? "");
  const design = designId ? await db.designs.get(designId) : undefined;
  const mockup = mockupId ? await db.mockups.get(mockupId) : undefined;
  if (!design || !mockup) {
    return { summary: "Design or mockup missing", error: "That design or mockup is no longer in this browser." };
  }
  const transform = clampTransform(payload.transform);
  try {
    await savePlacement({
      designId,
      mockupId,
      designAssetId: designMainAssetId(design),
      transform,
    });
    let templateId: string | undefined;
    if (payload.asTemplate === true) {
      const now = Date.now();
      const template: Template = {
        id: uid(),
        name: String(payload.templateName ?? "").trim() || `${design.name} placement`,
        category: "placement",
        description: `Saved by the agent from ${design.name} on ${mockup.name}`,
        version: 1,
        payload: { type: "placement", transform: { ...transform } },
        createdAt: now,
        updatedAt: now,
      };
      await db.templates.put(template);
      templateId = template.id;
      await logActivity("template.apply", `Agent created placement template “${template.name}”`);
    }
    return {
      summary: `Saved the placement for “${design.name}” on “${mockup.name}”${templateId ? " and its template" : ""}`,
      result: { designId, mockupId, transform, templateId },
    };
  } catch (error) {
    return { summary: "Could not save the placement", error: error instanceof Error ? error.message : "Save failed." };
  }
}

// ---------------------------------------------------------------------------
// Ink variant (proposal + real write)
// ---------------------------------------------------------------------------

async function proposeInkVariant(args: Record<string, unknown>): Promise<ToolExecResult> {
  const designs = await db.designs.toArray();
  if (!designs.length) return { summary: "No designs to recolor", error: "Upload a design first." };
  const design = pickByName(designs, String(args.design ?? "")) ?? designs[0];
  const ink = args.ink === "black" ? "black" : "white";
  return {
    summary: `Ready to make a ${ink}-ink version of “${design.name}”`,
    confirmation: {
      detail: `Generate a ${ink}-ink version of “${design.name}”. The original file is kept.`,
      payload: { designId: design.id, designName: design.name, ink },
    },
  };
}

/** Runs a confirmed ink proposal: recolors the design and stores the variant. */
export async function confirmInkVariant(payload: Record<string, unknown>): Promise<ToolExecResult> {
  const designId = String(payload.designId ?? "");
  const design = designId ? await db.designs.get(designId) : undefined;
  if (!design) return { summary: "Design not found", error: "That design is no longer in this browser." };
  const ink = payload.ink === "black" ? "black" : "white";
  try {
    const blob = await getAssetBlob(designMainAssetId(design));
    if (!blob) return { summary: "Artwork missing", error: "The design's artwork is missing from storage." };
    const bmp = await decodeImage(blob);
    const { blob: outBlob } = await createInkVariantBlob(bmp, ink, (canvas) => canvasToBlob(canvas, "image/png"));
    bmp.close();
    const assetId = await setInkVariantAsset(design.id, ink, outBlob, `${design.name}-${ink}-ink.png`);
    return {
      summary: `Made a ${ink}-ink version of “${design.name}”`,
      result: { designId: design.id, ink, assetId },
    };
  } catch (error) {
    return { summary: "Ink variant failed", error: error instanceof Error ? error.message : "Ink variant failed." };
  }
}

// ---------------------------------------------------------------------------
// Background removal (proposal + real write)
// ---------------------------------------------------------------------------

async function proposeRemoveBackground(args: Record<string, unknown>): Promise<ToolExecResult> {
  const designs = await db.designs.toArray();
  if (!designs.length) return { summary: "No designs to process", error: "Upload a design first." };
  const design = pickByName(designs, String(args.design ?? "")) ?? designs[0];
  const engine: BgRemovalEngineId = args.engine === "ai-segmenter" ? "ai-segmenter" : "flood-key";
  const tolerance = Number(args.tolerance);
  return {
    summary: `Ready to remove the background from “${design.name}” (${engine})`,
    confirmation: {
      detail: `Remove the background from “${design.name}” using ${
        engine === "ai-segmenter" ? "AI segmentation (the first run downloads ~25 MB)" : "the flood-key engine"
      }. The original file is kept.`,
      payload: {
        designId: design.id,
        designName: design.name,
        engine,
        tolerance: Number.isFinite(tolerance) ? tolerance : undefined,
      },
    },
  };
}

/** Runs a confirmed background-removal proposal on a single design. */
export async function confirmRemoveBackground(payload: Record<string, unknown>): Promise<ToolExecResult> {
  const designId = String(payload.designId ?? "");
  const design = designId ? await db.designs.get(designId) : undefined;
  if (!design) return { summary: "Design not found", error: "That design is no longer in this browser." };
  const engine: BgRemovalEngineId = payload.engine === "ai-segmenter" ? "ai-segmenter" : "flood-key";
  const tolerance = typeof payload.tolerance === "number" ? payload.tolerance : undefined;
  try {
    const blob = await getAssetBlob(designMainAssetId(design));
    if (!blob) return { summary: "Artwork missing", error: "The design's artwork is missing from storage." };
    const out = await removeBackground(engine, blob, tolerance);
    if (out.transparency < 0.005) {
      return {
        summary: "No background detected",
        error: `No background was detected in “${design.name}”. Try the AI engine or a different image.`,
      };
    }
    const asset = await storeAsset(out.blob, `${design.name}-cutout.png`, "design-processed", {
      parentId: design.originalAssetId,
    });
    await db.designs.update(design.id, { processedAssetId: asset.id, updatedAt: Date.now() });
    await logActivity(
      "bgremoval.run",
      `Agent removed the background from “${design.name}” (${Math.round(out.transparency * 100)}% transparent)`,
    );
    return {
      summary: `Removed the background from “${design.name}” (${Math.round(out.transparency * 100)}% transparent)`,
      result: { designId: design.id, assetId: asset.id, transparency: out.transparency },
    };
  } catch (error) {
    return {
      summary: "Background removal failed",
      error: error instanceof Error ? error.message : "Background removal failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Save a chat image as a design or mockup (proposal + real write)
// ---------------------------------------------------------------------------

async function proposeSaveChatImage(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolExecResult> {
  const attachments = ctx?.attachments ?? [];
  if (!attachments.length) {
    return {
      summary: "No image attached",
      error: "Attach an image in the chat, then ask me to save it as a design or mockup.",
    };
  }
  const index = Math.max(0, Math.trunc(Number(args.index)) || 0);
  const image = attachments[index] ?? attachments[0];
  const kind = String(args.kind ?? "design").toLowerCase().startsWith("mock") ? "mockup" : "design";
  const name = String(args.name ?? "").trim() || image.name.replace(/\.[^.]+$/, "");
  const category = String(args.category ?? "other");
  return {
    summary: `Ready to save “${name}” as a ${kind}`,
    confirmation: {
      detail: `Save the attached image “${image.name}” as a ${kind} named “${name}”.`,
      payload: { kind, name, index, category },
    },
  };
}

/** Runs a confirmed chat-image proposal: stores the attachment in the library. */
export async function confirmSaveChatImage(
  payload: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<ToolExecResult> {
  const attachments = ctx?.attachments ?? [];
  const index = Math.max(0, Math.trunc(Number(payload.index)) || 0);
  const image = attachments[index] ?? attachments[0];
  if (!image) {
    return { summary: "Image not found", error: "That attached image is no longer available in this chat." };
  }
  const kind = payload.kind === "mockup" ? "mockup" : "design";
  const name = String(payload.name ?? "").trim() || image.name;
  try {
    const file = dataUrlToFile(image.dataUrl, name, image.mime);
    if (kind === "mockup") {
      const category = (String(payload.category ?? "other") as MockupCategory) || "other";
      const { mockup, error } = await createMockupFromFile(file, category);
      if (!mockup) return { summary: "Could not save the mockup", error };
      return { summary: `Saved “${mockup.name}” as a mockup`, result: { mockupId: mockup.id, name: mockup.name } };
    }
    const { design, error } = await createDesignFromFile(file);
    if (!design) return { summary: "Could not save the design", error };
    return { summary: `Saved “${design.name}” as a design`, result: { designId: design.id, name: design.name } };
  } catch (error) {
    return {
      summary: "Could not save the image",
      error: error instanceof Error ? error.message : "Save failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Printify product (proposal + real write)
// ---------------------------------------------------------------------------

/** Maps common product words to a Printify search term. */
const PRODUCT_TYPE_ALIASES: Record<string, string> = {
  "t-shirt": "tee",
  tshirt: "tee",
  "tee shirt": "tee",
  tee: "tee",
  shirt: "tee",
  hoodie: "hoodie",
  sweatshirt: "sweatshirt",
  mug: "mug",
  cup: "mug",
  poster: "poster",
  "wall art": "poster",
  tote: "tote",
  bag: "tote",
  sticker: "sticker",
  hat: "hat",
  cap: "cap",
  leggings: "leggings",
  "phone case": "phone case",
  case: "phone case",
  notebook: "notebook",
  blanket: "blanket",
  pillow: "pillow",
  canvas: "canvas",
};

async function searchBlueprints(query: string): Promise<BlueprintLite[]> {
  const clean = query.trim().toLowerCase();
  if (!clean) return [];
  const alias = PRODUCT_TYPE_ALIASES[clean] ?? PRODUCT_TYPE_ALIASES[clean.split(/\s+/)[0]] ?? clean;
  const res = await authedFetch(`/api/printify/catalog?q=${encodeURIComponent(alias)}&limit=25`);
  const data = (await res.json().catch(() => null)) as { blueprints?: BlueprintLite[]; error?: string } | null;
  if (!res.ok) {
    throw new Error(data?.error ?? `Printify catalog request failed (HTTP ${res.status}).`);
  }
  return Array.isArray(data?.blueprints) ? data.blueprints : [];
}

async function resolveProvider(blueprintId: number): Promise<number> {
  const res = await authedFetch(`/api/printify/catalog?id=${blueprintId}&providers=1`);
  const data = (await res.json().catch(() => null)) as {
    providers?: Array<{ id: number; title: string }>;
    error?: string;
  } | null;
  if (!res.ok) throw new Error(data?.error ?? `Printify catalog request failed (HTTP ${res.status}).`);
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  if (!providers.length) throw new Error(`No print providers are available for that product type.`);
  return providers[0].id;
}

interface CreateProductResponse {
  configured?: boolean;
  error?: string;
  product?: { id: string; title?: string; status?: string; permalink?: string };
}

async function proposePrintifyProduct(args: Record<string, unknown>): Promise<ToolExecResult> {
  const designs = await db.designs.toArray();
  if (!designs.length) {
    return { summary: "No designs to list", error: "Upload a design first, then I can list it on Printify." };
  }
  const design = pickByName(designs, String(args.design ?? "")) ?? designs[0];

  let blueprintId = Math.trunc(Number(args.blueprintId)) || 0;
  let printProviderId = Math.trunc(Number(args.printProviderId)) || 0;
  let blueprintTitle = "";
  const productType = String(args.productType ?? "").trim();

  // Resolve the blueprint from a product type when no explicit id was given.
  if (!blueprintId) {
    if (!productType) {
      return {
        summary: "Product type or blueprint needed",
        error:
          "Tell me the product type (for example “t-shirt”, “hoodie”, or “mug”), or pick a blueprint in Product Builder and give me its id.",
      };
    }
    try {
      const candidates = await searchBlueprints(productType);
      if (!candidates.length) {
        return {
          summary: "No matching product type",
          error: `I couldn’t find a Printify product type matching “${productType}”. Try another word, or browse in Product Builder.`,
        };
      }
      blueprintId = candidates[0].id;
      blueprintTitle = candidates[0].title;
    } catch (error) {
      return { summary: "Printify lookup failed", error: error instanceof Error ? error.message : "Lookup failed." };
    }
  }

  // Resolve a print provider when none was given.
  if (!printProviderId) {
    try {
      printProviderId = await resolveProvider(blueprintId);
    } catch (error) {
      return { summary: "No print provider", error: error instanceof Error ? error.message : "Lookup failed." };
    }
  }

  // Variants and print areas are provider-scoped in the Printify catalog.
  const res = await authedFetch(`/api/printify/catalog?id=${blueprintId}&provider=${printProviderId}`);
  const data = (await res.json().catch(() => null)) as { error?: string; variants?: VariantLite[] } | null;
  if (!res.ok) {
    return {
      summary: "Could not load variants for that print provider",
      error: data?.error ?? `Printify catalog request failed (HTTP ${res.status}).`,
    };
  }
  let available = (data?.variants ?? []).filter((v) => v.available !== false);
  if (!available.length) {
    return {
      summary: "No variants for that product type",
      error: "That product type has no available variants. Try another product type or print provider.",
    };
  }

  const filters = (args.variantFilters && typeof args.variantFilters === "object"
    ? args.variantFilters
    : {}) as { colors?: unknown; sizes?: unknown };
  const wantColors = Array.isArray(filters.colors) ? filters.colors.map((c) => String(c).toLowerCase()) : [];
  const wantSizes = Array.isArray(filters.sizes) ? filters.sizes.map((s) => String(s).toLowerCase()) : [];
  if (wantColors.length || wantSizes.length) {
    const filtered = available.filter((v) => {
      const color = (v.options?.color ?? "").toLowerCase();
      const size = (v.options?.size ?? "").toLowerCase();
      if (wantColors.length && !wantColors.some((c) => color.includes(c))) return false;
      if (wantSizes.length && !wantSizes.some((s) => size === s || size.includes(s))) return false;
      return true;
    });
    if (filtered.length) available = filtered;
  }

  const capped = Math.max(0, available.length - PRINTIFY_MAX_VARIANTS);
  const variants = available.slice(0, PRINTIFY_MAX_VARIANTS);
  const printArea =
    String(args.printArea ?? "").trim() ||
    variants.find((v) => v.placeholders?.length)?.placeholders?.[0]?.position ||
    "front";
  const title = String(args.title ?? "").trim() || design.name;
  const description = String(args.description ?? "").trim();
  const tags = sanitizeTags(args.tags);
  const ink = (["main", "white", "black"] as InkVariant[]).includes(args.ink as InkVariant)
    ? (args.ink as InkVariant)
    : "main";

  const perVariantPrices: Record<number, number> = {};
  if (args.prices && typeof args.prices === "object") {
    for (const [key, value] of Object.entries(args.prices as Record<string, unknown>)) {
      const id = Math.trunc(Number(key));
      const cents = Math.round(Number(value));
      if (id && cents > 0) perVariantPrices[id] = cents;
    }
  }
  const explicitPrice = Math.round(Number(args.price)) || 0;
  const basePrice = explicitPrice > 0 ? explicitPrice : Object.values(perVariantPrices)[0] ?? DEFAULT_LISTING_PRICE;
  const appliedDefault = !(explicitPrice > 0);
  const priceLabel = `$${(basePrice / 100).toFixed(2)}${appliedDefault ? " (default)" : ""}`;

  return {
    summary: `Ready to create “${title}” on Printify at ${priceLabel}`,
    confirmation: {
      detail: `${variants.length} variants · ${priceLabel} each · blueprint ${blueprintId}${
        blueprintTitle ? ` (${blueprintTitle})` : ""
      } · print provider ${printProviderId} · artwork: ${design.name} (${ink} ink)${
        tags.length ? ` · ${tags.length} tags` : ""
      }.${capped > 0 ? ` Printify caps a product at 100 variants, so ${capped} more were left out.` : ""}`,
      payload: {
        designId: design.id,
        designName: design.name,
        title,
        description,
        tags,
        blueprintId,
        printProviderId,
        price: basePrice,
        prices: Object.keys(perVariantPrices).length ? perVariantPrices : undefined,
        variantIds: variants.map((v) => v.id),
        printArea,
        ink,
      },
    },
  };
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
  const tags = sanitizeTags(payload.tags);
  const ink = (["main", "white", "black"] as InkVariant[]).includes(payload.ink as InkVariant)
    ? (payload.ink as InkVariant)
    : "main";
  const prices =
    payload.prices && typeof payload.prices === "object"
      ? (payload.prices as Record<string, number>)
      : undefined;
  const title = String(payload.title ?? "").trim() || design?.name || "Untitled product";
  const description = String(payload.description ?? "").trim();
  const printArea = String(payload.printArea ?? "front");

  if (!design) return { summary: "Design not found", error: "That design is no longer in this browser." };
  if (!blueprintId || !printProviderId || !(price > 0) || !variantIds.length) {
    return { summary: "Missing product details", error: "The proposal was incomplete; try again." };
  }

  try {
    const designAssetId = designAssetIdFor(design, ink);
    const blob = designAssetId ? await getAssetBlob(designAssetId) : undefined;
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
        tags: tags.length ? tags : undefined,
        blueprintId,
        printProviderId,
        price,
        prices,
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
      designAssetId: designAssetId ?? "",
      blueprintId,
      printProviderId,
      description: description || undefined,
      priceCents: price,
      variantSelection: { [String(blueprintId)]: variantIds },
      printAreaConfig: { printArea },
      status: "created-remote",
      remoteProductId: data.product.id,
      remotePermalink: data.product.permalink,
      createdAt: now,
      updatedAt: now,
    };
    await db.productDrafts.put(draft);
    await logActivity("product.create", `Created Printify product “${title}”`, {
      productId: data.product.id,
      blueprintId,
      printProviderId,
      price,
      tags,
    });

    return {
      summary: `Created Printify product “${title}” (${data.product.id})`,
      result: {
        productId: data.product.id,
        title,
        blueprintId,
        printProviderId,
        price,
        variants: variantIds.length,
        tags,
      },
    };
  } catch (error) {
    return {
      summary: "Printify product creation failed",
      error: error instanceof Error ? error.message : "Printify product creation failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<ToolExecResult> {
  try {
    switch (name) {
      case "explain_howto":
        return explainHowto(args);
      case "summarize_workspace":
        return await summarizeWorkspace();
      case "list_library":
        return await listLibrary(args);
      case "browse_printify_catalog":
        return await browsePrintifyCatalog(args);
      case "draft_listing":
        return await draftListing(args);
      case "create_batch_job":
        return await proposeBatchJob(args);
      case "create_mockup_render":
        return await proposeMockupRender(args);
      case "save_placement":
        return await proposeSavePlacement(args);
      case "create_ink_variant":
        return await proposeInkVariant(args);
      case "remove_background":
        return await proposeRemoveBackground(args);
      case "save_chat_image":
        return await proposeSaveChatImage(args, ctx);
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

/** Confirm-gated tools the UI runs after the user clicks Create. */
export type ConfirmToolRunner = (
  payload: Record<string, unknown>,
  ctx?: ToolContext,
) => Promise<ToolExecResult>;

export const CONFIRM_TOOL_RUNNERS: Record<string, ConfirmToolRunner> = {
  create_batch_job: confirmBatchJob,
  create_printify_product: confirmPrintifyProduct,
  create_mockup_render: confirmMockupRender,
  save_placement: confirmSavePlacement,
  create_ink_variant: confirmInkVariant,
  remove_background: confirmRemoveBackground,
  save_chat_image: confirmSaveChatImage,
};
