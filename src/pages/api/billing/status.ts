import type { APIRoute } from "astro";
import { json, serverEnv } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";
import { requireAuth } from "@/lib/auth/middleware";
import { readUsage } from "@/lib/billing/server";
import { fetchUsdInrRate } from "@/lib/billing/server";
import { PLANS, PLAN_ORDER, inrForPlan } from "@/lib/billing/plans";

/**
 * GET /api/billing/status — what the current user may do and what it costs.
 *
 * Signed-in callers get their real plan and this month's usage. A signed-out
 * caller gets the free plan honestly (the tools stay login-free; only
 * creation counts the quota, and that requires an account).
 */
export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const auth = request.headers.get("authorization")?.startsWith("Bearer ")
    ? await requireAuth(request, locals)
    : null;
  const userId = auth && !(auth instanceof Response) ? auth.userId : null;

  const { admin, configured } = authClients(locals);
  const usage = userId
    ? await readUsage(admin, userId)
    : { plan: "free" as const, cap: PLANS.free.listingCap, used: 0, planExpiresAt: null };

  const rate = await fetchUsdInrRate();
  const razorpayConfigured = Boolean(
    serverEnv.razorpayKeyId()?.trim() && serverEnv.razorpayKeySecret()?.trim(),
  );

  return json({
    signedIn: Boolean(userId),
    authConfigured: configured,
    plan: usage.plan,
    cap: usage.cap,
    used: usage.used,
    remaining: Math.max(0, usage.cap - usage.used),
    planExpiresAt: usage.planExpiresAt,
    razorpay: {
      configured: razorpayConfigured,
      keyId: razorpayConfigured ? (serverEnv.razorpayKeyId()?.trim() ?? null) : null,
    },
    fx: { usdInr: rate.rate, source: rate.source },
    plans: PLAN_ORDER.map((id) => {
      const plan = PLANS[id];
      return {
        id: plan.id,
        label: plan.label,
        usd: plan.usd,
        listingCap: plan.listingCap,
        tagline: plan.tagline,
        inr: plan.usd > 0 ? inrForPlan(plan, rate.rate) : 0,
      };
    }),
  });
};
