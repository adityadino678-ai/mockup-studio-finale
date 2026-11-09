import type { APIRoute } from "astro";
import { json, serverEnv } from "@/lib/server/env";
import { sameOriginRequest } from "@/lib/server/same-origin";
import { computeLaunchReadiness } from "@/lib/server/launch-readiness";

// Launch-readiness checklist for email, auth, billing and the site URL.
//
// Read-only: this route only reports which pieces are configured. It never
// sends mail, never charges, never invents a price and never returns a secret
// value, prefix, suffix or length. Cache-Control: no-store comes from json().
export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }

  const readiness = computeLaunchReadiness({
    siteUrl: import.meta.env.PUBLIC_SITE_URL,
    supabaseUrl: serverEnv.supabaseUrl(),
    supabaseAnonKey: serverEnv.supabaseAnonKey(),
    supabaseServiceRole: serverEnv.supabaseServiceRole(),
    resendApiKey: serverEnv.resendApiKey(),
    resendFrom: serverEnv.resendFrom(),
    razorpayKeyId: serverEnv.razorpayKeyId(),
    razorpayKeySecret: serverEnv.razorpayKeySecret(),
  });

  return json({
    checkedAt: Date.now(),
    ready: readiness.ready,
    items: readiness.items,
  });
};
