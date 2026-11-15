import type { APIRoute } from "astro";
import { json, serverEnv } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";
import { requireAuth } from "@/lib/auth/middleware";
import { BillingError, createRazorpayOrder } from "@/lib/billing/server";
import { planOf } from "@/lib/billing/plans";

/**
 * POST /api/billing/checkout — create one Razorpay order for a plan.
 *
 * Same-origin + JSON only. The order is priced at TODAY'S live USD→INR rate,
 * so the browser's checkout opens with the exact amount it will charge. The
 * caller must be signed in: the plan is granted to the account, never to a
 * stranger.
 */
export const prerender = false;

function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  const auth = await requireAuth(request, locals);
  if (auth instanceof Response) return auth;

  const raw = (await request.json().catch(() => ({}))) as { plan?: unknown };
  const planId = planOf(typeof raw.plan === "string" ? raw.plan : "free").id;
  if (planId === "free") {
    return json({ error: "The Free plan needs no payment — just start using the Studio." }, 400);
  }

  const { admin } = authClients(locals);
  try {
    const { order, amountInr, rate } = await createRazorpayOrder(
      { planId, userId: auth.userId, email: auth.email },
      {
        razorpayKeyId: serverEnv.razorpayKeyId(),
        razorpayKeySecret: serverEnv.razorpayKeySecret(),
      },
    );
    // The profile row must exist before the payment can grant a plan; a
    // signup always creates one, but an admin-created account may not have it.
    await admin?.from("profiles").upsert({ id: auth.userId }, { onConflict: "id" });
    return json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: order.keyId,
      plan: planId,
      amountInr,
      rate: { usdInr: rate.rate, source: rate.source },
      prefill: { email: auth.email },
    });
  } catch (error) {
    if (error instanceof BillingError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    return json(
      { error: error instanceof Error ? error.message : "Checkout could not start." },
      500,
    );
  }
};
