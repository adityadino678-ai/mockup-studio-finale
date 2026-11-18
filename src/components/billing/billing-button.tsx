"use client";

import * as React from "react";
import { authedFetch } from "@/lib/client/integrations";

/**
 * The "Choose <plan>" button under each paid plan on /pricing.
 *
 * The flow is entirely user-account-bound:
 *   1. signed out → open the landing's sign-up dialog (/?auth=up);
 *   2. billing not configured yet → an honest "goes live soon" message;
 *   3. otherwise create a Razorpay order at today's live rate, open
 *      Razorpay Checkout, and verify the result server-side before the UI
 *      says the plan is active.
 *
 * The checkout script (checkout.razorpay.com) is loaded on demand, once.
 */

type BillingStatus = {
  signedIn: boolean;
  razorpay: { configured: boolean; keyId: string | null };
  plan: string;
  cap: number;
  used: number;
  plans?: Array<{ id: string; usd: number; listingCap: number; inr?: number }>;
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadCheckout(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

export function BillingButton({
  planId,
  label,
}: {
  planId: "starter" | "pro" | "business";
  label: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await authedFetch("/api/billing/status");
      const status = (await res.json()) as BillingStatus;
      if (!status.signedIn) {
        // The landing page's dialog is the only sign-up surface.
        window.location.assign("/?auth=up");
        return;
      }
      if (!status.razorpay.configured) {
        setMessage("Payments go live soon — the plan prices are final, checkout opens shortly.");
        return;
      }
      const orderRes = await authedFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planId }),
      });
      const order = await orderRes.json().catch(() => ({}));
      if (!orderRes.ok) {
        setMessage(order.error ?? "Checkout could not start. Try again in a moment.");
        return;
      }
      const ready = await loadCheckout();
      if (!ready || !window.Razorpay) {
        setMessage("The payment window could not load. Check your connection and retry.");
        return;
      }
      const checkout = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: "ListBulkly",
        description: `${label} plan — ${order.amountInr.toLocaleString("en-IN")} INR/month`,
        prefill: order.prefill ?? {},
        theme: { color: "#F97B12" },
        handler: async (result: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          const verifyRes = await authedFetch("/api/billing/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(result),
          });
          const verify = await verifyRes.json().catch(() => ({}));
          if (verifyRes.ok && verify.ok) {
            setMessage(`You're on the ${label} plan — ${verify.cap} listings a month. Back to the Studio!`);
          } else {
            setMessage(verify.error ?? "The payment succeeded but could not be verified. Contact support with your payment id.");
          }
        },
      });
      checkout.open();
    } catch {
      setMessage("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="billing-button">
      <button type="button" onClick={onClick} disabled={busy} className="sk-btn">
        {busy ? "Opening checkout…" : label}
      </button>
      {message ? <p className="billing-button__message">{message}</p> : null}
    </div>
  );
}
