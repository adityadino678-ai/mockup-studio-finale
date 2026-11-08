import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";

export const prerender = false;

/**
 * Public auth status. Says whether Supabase Auth is configured and which
 * sign-up path is live, without ever returning a key or a user record.
 *
 * The Settings card used to treat a 401 from `/api/auth/me` as "not
 * configured", so a perfectly configured project looked broken whenever the
 * visitor was signed out. This endpoint is the distinction.
 */
export const GET: APIRoute = ({ locals }) => {
  const { configured, serviceRole } = authClients(locals);

  return json({
    configured,
    serviceRole,
    signupMode: !configured ? "disabled" : serviceRole ? "instant" : "email-confirmation",
  });
};
