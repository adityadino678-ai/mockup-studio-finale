import type { APIRoute } from "astro";
import { json, serverEnv } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";
import {
  BillingError,
  grantPlan,
  verifyWebhookSignature,
} from "@/lib/billing/server";
import { planOf } from "@/lib/billing/plans";

/**
 * POST /api/billing/webhook — Razorpay's backstop for payments the browser
 * never reported (a closed tab after a successful payment, a renewal).
 *
 * The FULL raw body is what the signature is computed over, so the body must
 * be read as text BEFORE anything else touches it. `x-razorpay-signature`
 * carries the HMAC-SHA256 of that body with the webhook secret
 * (RAZORPAY_WEBHOOK_SECRET — set it in the Razorpay dashboard AND as a
 * wrangler secret).
 *
 * Handled events:
 *  - order.paid / payment.captured → grant the plan named in the order notes
 *    to the user named there. The notes are written by our own checkout, so
 *    the user_id and plan never come from the request body.
 */
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  const secret = serverEnv.razorpayWebhookSecret();

  if (!secret?.trim()) {
    // No webhook secret configured: refuse honestly instead of accepting everything.
    return json({ error: "Webhooks are not configured on this deployment." }, 503);
  }
  if (!verifyWebhookSignature(raw, signature, secret)) {
    return json({ error: "Invalid webhook signature." }, 400);
  }

  let event: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; status?: string } };
      order?: { entity?: { id?: string; notes?: Record<string, string> } };
    };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Malformed webhook body." }, 400);
  }

  const name = event.event ?? "";
  if (name !== "order.paid" && name !== "payment.captured") {
    return json({ ok: true, ignored: name });
  }

  const order = event.payload?.order?.entity;
  const payment = event.payload?.payment?.entity;
  const notes = order?.notes ?? {};
  const userId = notes.user_id;
  const planId = planOf(notes.plan).id;

  if (!userId || planId === "free") {
    // An order this app did not create (or a manual order) — nothing to grant.
    return json({ ok: true, ignored: "no plan or user in the order notes" });
  }

  const { admin } = authClients(locals);
  try {
    await grantPlan(admin, userId, planId);
    return json({ ok: true, granted: planId, paymentId: payment?.id ?? null });
  } catch (error) {
    if (error instanceof BillingError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "The webhook could not grant the plan." }, 500);
  }
};
