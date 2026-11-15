// Server half of billing: usage counting, plan state, Razorpay orders.
//
// Two rules drive this module:
// 1. The quota is decided SERVER-SIDE. Listings live in the visitor's
//    IndexedDB, so a browser-only counter could simply be edited away. Every
//    Printify product the app creates is counted here, per signed-in user,
//    keyed by calendar month (UTC).
// 2. Razorpay settles in INR, so a plan priced in USD is converted at the LIVE
//    exchange rate at checkout. The rate comes from the ECB-backed
//    frankfurter.app API, cached for an hour; a fixed fallback rate keeps
//    checkout working when that source is unreachable (the order then says so
//    in its notes).
//
// Every database access uses the service-role admin client, because the usage
// row is written by the server during a product create, not by the browser.

import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FALLBACK_USD_INR,
  PLAN_PERIOD_DAYS,
  inrForPlan,
  planOf,
  paise,
  usageMonth,
  type PlanId,
} from "./plans";

/** A day's grace keeps a renewal that pays a few hours late from dropping the plan. */
export const planExpiresAt = (from: Date = new Date()): string => {
  const expires = new Date(from);
  expires.setUTCDate(expires.getUTCDate() + PLAN_PERIOD_DAYS);
  return expires.toISOString();
};

/** The plan that is in force RIGHT NOW: expired paid plans read as free. */
export function effectivePlan(plan: string | null | undefined, expiresAt: string | null | undefined): PlanId {
  const id = planOf(plan).id;
  if (id === "free") return "free";
  if (!expiresAt) return "free";
  return new Date(expiresAt).getTime() > Date.now() ? id : "free";
}

export interface UsageState {
  plan: PlanId;
  cap: number;
  used: number;
  planExpiresAt: string | null;
}

/**
 * Reads the signed-in user's plan and this month's usage.
 * A missing profile row (or a missing table) reads as the free plan with zero
 * usage, so a database hiccup never invents quota — it only ever denies less.
 */
export async function readUsage(
  admin: SupabaseClient | null,
  userId: string,
): Promise<UsageState> {
  if (!admin) return { plan: "free", cap: planOf("free").listingCap, used: 0, planExpiresAt: null };
  const [{ data: profile }, { data: usage }] = await Promise.all([
    admin.from("profiles").select("plan, plan_expires_at").eq("id", userId).maybeSingle(),
    admin
      .from("listing_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("ym", usageMonth())
      .maybeSingle(),
  ]);
  const plan = effectivePlan(profile?.plan, profile?.plan_expires_at);
  const used = typeof usage?.count === "number" && usage.count > 0 ? usage.count : 0;
  return { plan, cap: planOf(plan).listingCap, used, planExpiresAt: profile?.plan_expires_at ?? null };
}

/**
 * Adds one created product to the user's month. The increment happens in SQL
 * (`increment_listing_usage`, created by migration 006) so two creates that
 * land together cannot lose a count. If the function is missing (an old
 * database), the request still succeeds — the count is best-effort and the
 * honest cap message tells the user what was counted.
 */
export async function recordProductCreated(
  admin: SupabaseClient | null,
  userId: string,
): Promise<void> {
  if (!admin) return;
  const { error } = await admin.rpc("increment_listing_usage", {
    p_user_id: userId,
    p_ym: usageMonth(),
  });
  if (error) {
    // An old database without the function: write the row directly rather
    // than silently dropping the count. One concurrent create could lose its
    // increment this way — acceptable for a fallback path that should never
    // run (the migration ships with the deployment).
    const ym = usageMonth();
    const { data } = await admin
      .from("listing_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("ym", ym)
      .maybeSingle();
    const next = typeof data?.count === "number" && data.count > 0 ? data.count + 1 : 1;
    await admin
      .from("listing_usage")
      .upsert({ user_id: userId, ym, count: next }, { onConflict: "user_id,ym" });
  }
}

// --- FX ---------------------------------------------------------------------

interface FxCache {
  at: number;
  rate: number;
  source: "live" | "fallback";
}

let fxCache: FxCache | null = null;
const FX_TTL = 60 * 60 * 1000;

/**
 * The live USD→INR rate. Cached per isolate for an hour; the ECB-backed
 * frankfurter.app endpoint needs no key. On any failure the cached rate (or
 * the fixed fallback) is used and the source says so — checkout never breaks
 * because a rate API is down.
 */
export async function fetchUsdInrRate(): Promise<FxCache> {
  if (fxCache && Date.now() - fxCache.at < FX_TTL) return fxCache;
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=INR", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { rates?: { INR?: number } };
    const rate = data.rates?.INR;
    if (typeof rate === "number" && rate > 20 && rate < 500) {
      fxCache = { at: Date.now(), rate, source: "live" };
      return fxCache;
    }
    throw new Error("rate out of range");
  } catch {
    const rate = fxCache?.rate ?? FALLBACK_USD_INR;
    return { at: Date.now(), rate, source: "fallback" };
  }
}

// --- Razorpay orders --------------------------------------------------------

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  keyId: string | null;
}

export interface CreateOrderInput {
  planId: PlanId;
  userId: string;
  email: string;
  name?: string;
}

export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Creates one Razorpay order for a plan at today's live rate. A fresh order
 * per purchase (rather than a fixed plan id) is what makes the moving
 * exchange rate possible: every cycle re-prices at that day's rate.
 */
export async function createRazorpayOrder(
  input: CreateOrderInput,
  secrets: { razorpayKeyId?: string | null; razorpayKeySecret?: string | null },
): Promise<{ order: RazorpayOrder; amountInr: number; rate: FxCache }> {
  const keyId = secrets.razorpayKeyId?.trim();
  const keySecret = secrets.razorpayKeySecret?.trim();
  if (!keyId || !keySecret) {
    throw new BillingError("Billing is not configured yet. Payments go live soon.", 503, "billing-unconfigured");
  }
  const plan = planOf(input.planId);
  if (plan.id === "free") {
    throw new BillingError("The Free plan needs no payment.", 400, "free-plan");
  }
  const rate = await fetchUsdInrRate();
  const amountInr = inrForPlan(plan, rate.rate);

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: paise(amountInr),
      currency: "INR",
      receipt: `${plan.id}-${Date.now()}`,
      notes: {
        user_id: input.userId,
        plan: plan.id,
        usd: String(plan.usd),
        usd_inr: rate.rate.toFixed(4),
        rate_source: rate.source,
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    amount?: number;
    currency?: string;
    error?: { description?: string };
  };
  if (!res.ok || !data.id) {
    throw new BillingError(
      data.error?.description ?? "Razorpay refused the order. Try again in a moment.",
      502,
      "razorpay-order",
    );
  }
  return {
    order: { id: data.id, amount: data.amount ?? paise(amountInr), currency: data.currency ?? "INR", keyId },
    amountInr,
    rate,
  };
}

/** Verifies the checkout handler's signature (order_id|payment_id → HMAC-SHA256). */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string | null | undefined,
): boolean {
  if (!keySecret?.trim() || !orderId || !paymentId || !signature) return false;
  const expected = createHmac("sha256", keySecret.trim())
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return expected === signature;
}

/** Verifies a webhook payload against the webhook secret (full body → HMAC-SHA256). */
export function verifyWebhookSignature(body: string, signature: string, secret: string | null | undefined): boolean {
  if (!secret?.trim() || !signature) return false;
  const expected = createHmac("sha256", secret.trim()).update(body).digest("hex");
  return expected === signature;
}

/** Sets the user's plan after a verified payment. */
export async function grantPlan(
  admin: SupabaseClient | null,
  userId: string,
  planId: PlanId,
): Promise<void> {
  if (!admin) throw new BillingError("Supabase is not configured.", 503, "not-configured");
  const { error } = await admin
    .from("profiles")
    .update({ plan: planId, plan_expires_at: planExpiresAt() })
    .eq("id", userId);
  if (error) {
    throw new BillingError("The payment succeeded but the plan could not be saved. Contact support.", 502, "grant-failed");
  }
}
