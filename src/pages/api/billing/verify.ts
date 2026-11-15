import type { APIRoute } from "astro";
import { json, serverEnv } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";
import { requireAuth } from "@/lib/auth/middleware";
import {
  BillingError,
  grantPlan,
  readUsage,
  verifyCheckoutSignature,
} from "@/lib/billing/server";
import { planOf } from "@/lib/billing/plans";

/**
 * POST /api/billing/verify — confirm the checkout result and grant the plan.
 *
 * The browser's Razorpay handler comes back with
 * `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`; the
 * signature is HMAC-SHA256(order_id|payment_id, key_secret) and is verified
 * HERE, with the server's secret — the browser never holds it. Verified means
 * the plan is granted at once; the webhook only acts as a backstop for
 * renewals, so the user sees their plan immediately after paying.
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

  const body = (await request.json().catch(() => ({}))) as {
    razorpay_order_id?: unknown;
    razorpay_payment_id?: unknown;
    razorpay_signature?: unknown;
  };
  const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
  const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
  const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
  if (!orderId || !paymentId || !signature) {
    return json({ error: "Missing the checkout result fields." }, 400);
  }
  // Ids and signatures are opaque tokens: bound their length before use.
  if (
    orderId.length > 64 ||
    paymentId.length > 64 ||
    signature.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(orderId) ||
    !/^[A-Za-z0-9_-]+$/.test(paymentId)
  ) {
    return json({ error: "Malformed checkout result." }, 400);
  }

  const { admin } = authClients(locals);
  const keySecret = serverEnv.razorpayKeySecret();
  if (!verifyCheckoutSignature(orderId, paymentId, signature, keySecret)) {
    return json({ error: "The payment signature could not be verified. No plan was granted." }, 400);
  }

  try {
    // The plan comes from the order's notes — the authoritative record of what
    // was bought. Read it back from Razorpay rather than trusting the browser.
    const keyId = serverEnv.razorpayKeyId()?.trim();
    const key = keySecret?.trim();
    if (!keyId || !key) {
      return json({ error: "Billing is not configured yet." }, 503);
    }
    const auth64 = Buffer.from(`${keyId}:${key}`).toString("base64");
    const res = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
      headers: { Authorization: `Basic ${auth64}` },
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      notes?: { plan?: string; user_id?: string };
    };
    if (!res.ok) {
      return json({ error: "The order could not be read back. No plan was granted." }, 502);
    }
    if (data.notes?.user_id && data.notes.user_id !== auth.userId) {
      return json({ error: "This order belongs to another account." }, 403);
    }
    const planId = planOf(data.notes?.plan).id;
    if (planId === "free") {
      return json({ error: "This order names no paid plan." }, 400);
    }
    await grantPlan(admin, auth.userId, planId);
    const usage = await readUsage(admin, auth.userId);
    return json({ ok: true, plan: planId, cap: usage.cap, used: usage.used, planExpiresAt: usage.planExpiresAt });
  } catch (error) {
    if (error instanceof BillingError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    return json({ error: error instanceof Error ? error.message : "Verification failed." }, 500);
  }
};
