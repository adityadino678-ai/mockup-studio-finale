import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";

export const prerender = false;

/**
 * Auth return endpoint.
 *
 * It used to call `requireAuth()` before exchanging the code, which can never
 * succeed: the caller is arriving FROM the auth provider and has no app token
 * yet. It now accepts either shape the provider can send:
 *
 * - `?code=…` from a PKCE flow (exchanged server-side), and
 * - `?access_token=…` from the implicit flow our server-side `signUp` uses,
 *   which is verified and echoed back.
 *
 * The static `/auth/confirm` page handles the implicit-flow hash in the browser,
 * because a URL fragment never reaches the server.
 */
export const GET: APIRoute = async ({ request, url, locals }) => {
  const { client, admin } = authClients(locals);
  const supabase = client ?? admin;

  if (!supabase) {
    return json({ error: "not_configured", message: "Supabase Auth is not configured." }, 503);
  }

  const code = url.searchParams.get("code");
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error || !data.session) {
      return json({ error: "auth_failed", message: error?.message ?? "Callback failed." }, 401);
    }

    return json({
      ok: true,
      user: { id: data.user.id, email: data.user.email ?? "" },
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? null,
    });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = url.searchParams.get("access_token") ??
    (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "");

  if (!token) {
    return json(
      { error: "bad_request", message: "Missing auth code or access token." },
      400,
    );
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return json({ error: "auth_failed", message: "Invalid or expired token." }, 401);
  }

  return json({
    ok: true,
    user: { id: data.user.id, email: data.user.email ?? "" },
  });
};
