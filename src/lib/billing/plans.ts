/**
 * The ListBulkly plans — the single source of truth for pricing.
 *
 * Prices are set in USD and charged in the user's currency at the LIVE
 * exchange rate of the day (see `lib/billing/server.ts` → `fetchUsdInrRate`),
 * so the INR amount moves with the market and is never a fixed promise.
 *
 * `listingCap` counts Printify products CREATED through the app's API in one
 * calendar month (UTC). Copy updates, image uploads and publishes of products
 * that already exist do not consume the quota — only creation does.
 */

export type PlanId = "free" | "starter" | "pro" | "business";

export interface PlanDef {
  id: PlanId;
  label: string;
  /** Monthly price in whole USD. */
  usd: number;
  /** Printify products that may be created per calendar month. */
  listingCap: number;
  tagline: string;
}

export const PLANS: Record<PlanId, PlanDef> = {
  free: {
    id: "free",
    label: "Free",
    usd: 0,
    listingCap: 5,
    tagline: "Try the whole workflow, no card.",
  },
  starter: {
    id: "starter",
    label: "Starter",
    usd: 10,
    listingCap: 150,
    tagline: "For the first steady shop.",
  },
  pro: {
    id: "pro",
    label: "Pro",
    usd: 20,
    listingCap: 250,
    tagline: "For a growing catalogue.",
  },
  business: {
    id: "business",
    label: "Business",
    usd: 30,
    listingCap: 400,
    tagline: "For volume sellers.",
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "starter", "pro", "business"];

export function planOf(id: string | null | undefined): PlanDef {
  if (id === "starter" || id === "pro" || id === "business") return PLANS[id];
  return PLANS.free;
}

/** Fallback USD→INR rate, used only when the live FX source is unreachable. */
export const FALLBACK_USD_INR = 88;

/** Round the converted price to the nearest ten of the target currency. */
export function roundPrice(amount: number): number {
  return Math.round(amount / 10) * 10;
}

/** `USD → INR` for one plan at a given rate, rounded for checkout. */
export function inrForPlan(plan: PlanDef, usdInrRate: number): number {
  return roundPrice(plan.usd * usdInrRate);
}

/** Razorpay amounts are in paise (the smallest INR unit). */
export function paise(inr: number): number {
  return Math.round(inr * 100);
}

/** The calendar month (YYYY-MM, UTC) a timestamp belongs to. */
export function usageMonth(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** How long a purchase grants the plan: one month, plus a day of grace. */
export const PLAN_PERIOD_DAYS = 31;
