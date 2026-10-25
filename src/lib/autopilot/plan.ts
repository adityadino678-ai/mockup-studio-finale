// ---------------------------------------------------------------------------
// Turning a Studio plan into reviewable autopilot listings.
//
// The plan already says which design owns which listing and which colours it
// prints. This module adds the copy layer:
//
//   * research is SHARED for the run (one Etsy query), so every listing is
//     grounded in the same observed market;
//   * AI copy is merged into a strict Etsy shape (140-char title, 13 tags of
//     20 chars, 5000-char description);
//   * a deterministic fallback still produces a complete listing when the AI
//     is not configured or fails.
//
// It is pure: no network, no IndexedDB, no React.
// ---------------------------------------------------------------------------

import { parseTags, priceForListing, renderTemplate, renderTitle } from "@/lib/printify/studio-session";
import type { StudioPlan } from "@/lib/printify/studio-plan";
import type { AutopilotCopy, AutopilotListing } from "@/types/autopilot";
import type { Design, StudioSession } from "@/types/domain";
import type { EtsyResearch } from "@/types/etsy";

export const AUTOPILOT_TITLE_LIMIT = 140;
export const AUTOPILOT_DESCRIPTION_LIMIT = 5000;
export const AUTOPILOT_TAG_LIMIT = 13;
export const AUTOPILOT_TAG_LENGTH = 20;

/** A listing's reviewable skeleton, before any research or copy exists. */
export function buildAutopilotListings(plan: StudioPlan): AutopilotListing[] {
  const now = Date.now();
  return plan.items.map((item) => ({
    id: item.listingId,
    designId: item.designId,
    memberIds: item.memberIds,
    designName: item.designName,
    ...(item.partnerName ? { partnerName: item.partnerName } : {}),
    status: "pending",
    updatedAt: now,
  }));
}

/** Etsy's real limits, applied to any tag list, in order, with dedupe. */
export function normaliseTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const tag = value
      .trim()
      .replace(/^#+/, "")
      .replace(/\s+/g, " ")
      .slice(0, AUTOPILOT_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= AUTOPILOT_TAG_LIMIT) break;
  }
  return out;
}

/**
 * A complete, honest listing without AI.
 *
 * The title/description come from the Studio's own templates, so the copy the
 * user already configured is never discarded. The Etsy terms are added only
 * when they fit the tag limit.
 */
export function fallbackCopy(
  item: AutopilotListing,
  session: StudioSession,
  productName: string,
  priceCents: number,
  research?: EtsyResearch,
): AutopilotCopy {
  const title =
    renderTitle(session.titleTemplate, item.designName, productName).trim() ||
    `${item.designName} - ${productName}`.slice(0, AUTOPILOT_TITLE_LIMIT);
  const description =
    renderTemplate(
      session.descriptionTemplate,
      item.designName,
      productName,
      `${item.designName}. A ${productName} printed to order.`,
      AUTOPILOT_DESCRIPTION_LIMIT,
    ) || `${item.designName}. A ${productName} printed to order.`;
  const tags = normaliseTags([
    ...parseTags(session.tags),
    ...(research?.topTags ?? []).map((entry) => entry.term),
    ...(research?.titleTerms ?? []).map((entry) => entry.term),
  ]);
  return {
    title: title.slice(0, AUTOPILOT_TITLE_LIMIT),
    description: description.slice(0, AUTOPILOT_DESCRIPTION_LIMIT),
    tags,
    priceCents,
    category: session.category?.trim() || undefined,
    quantity: session.quantity && session.quantity > 0 ? Math.round(session.quantity) : 1,
    groundedOnEtsy: Boolean(research),
    disclaimer: research?.disclaimer,
  };
}

export interface AiListingResult {
  titleDrafts?: unknown;
  title?: unknown;
  descriptionDraft?: unknown;
  description?: unknown;
  tags?: unknown;
  disclaimer?: unknown;
}

function firstString(values: unknown): string | undefined {
  if (typeof values === "string") return values;
  if (!Array.isArray(values)) return undefined;
  return values.find((value): value is string => typeof value === "string");
}

/**
 * Merges AI copy over the fallback, without trusting it.
 *
 * The AI is a writer, not an authority on Etsy's limits or on the seller's
 * product. The title/description are length-checked, tags are deduped and
 * capped, and the price ALWAYS comes from the run's explicit price - a model
 * never gets to change what the seller charges.
 */
export function mergeAiCopy(
  base: AutopilotCopy,
  ai: AiListingResult | null | undefined,
  research?: EtsyResearch,
): AutopilotCopy {
  if (!ai) return base;
  const title = (firstString(ai.titleDrafts) ?? firstString(ai.title) ?? "").trim();
  const description = (firstString(ai.descriptionDraft) ?? firstString(ai.description) ?? "").trim();
  const tags = normaliseTags([
    ...(Array.isArray(ai.tags) ? ai.tags : []),
    ...base.tags,
    ...(research?.topTags ?? []).map((entry) => entry.term),
  ]);
  return {
    ...base,
    title: (title || base.title).slice(0, AUTOPILOT_TITLE_LIMIT),
    description: (description || base.description).slice(0, AUTOPILOT_DESCRIPTION_LIMIT),
    tags: tags.length > 0 ? tags : base.tags,
    groundedOnEtsy: Boolean(research) || base.groundedOnEtsy,
    disclaimer:
      typeof ai.disclaimer === "string" && ai.disclaimer.trim()
        ? ai.disclaimer.trim().slice(0, 500)
        : base.disclaimer,
  };
}

/** Problems that must be fixed BEFORE a run can start. */
export function autopilotStartProblems(params: {
  designs: Design[];
  session: StudioSession;
  plan: StudioPlan | null;
  planProblems: string[];
  priceCents: number;
  hasEtsyKey: boolean;
  shopId?: number;
}): string[] {
  const problems: string[] = [];
  if (!params.hasEtsyKey) {
    problems.push(
      "Etsy research needs a developer keystring. Add one in Settings -> API connections.",
    );
  }
  if (!params.shopId) {
    problems.push("Choose the Printify shop in Settings -> API connections.");
  }
  if (!params.plan) {
    problems.push("Open the Printify Studio and choose a product and print provider first.");
  }
  if (params.session.designIds.length === 0) {
    problems.push("Tick at least one design in the Studio; an empty selection would create nothing.");
  }
  if (params.priceCents < 100) {
    problems.push("Enter a deliberate price of at least 1.00 before starting.");
  }
  problems.push(...params.planProblems);
  return problems;
}

/** The Studio price for a listing, used only to prefill the explicit field. */
export function suggestedPrice(session: StudioSession, listingId?: string): number {
  return listingId ? priceForListing(session, listingId) : (session.priceCents ?? 1999);
}

/**
 * Takes the LATEST placement and saved renders from the Studio session while
 * keeping the run's own design and image selection.
 *
 * A run snapshots the Studio when it starts, so the reviewed copy and mockup
 * set cannot change underneath it. Renders, however, are saved while the user
 * reviews copy - after the snapshot was written. Without this merge the run
 * would keep asking for a render that the user has already saved.
 */
export function withCurrentRenderState(
  snapshot: StudioSession,
  current: StudioSession,
): StudioSession {
  return {
    ...snapshot,
    universalPlacement: current.universalPlacement,
    placements: current.placements,
    listingRenders: current.listingRenders,
  };
}
