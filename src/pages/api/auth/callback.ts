import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { supabaseAdmin } from "@/lib/auth/supabase-auth";
import { requireAuth } from "@/lib/auth/middleware";

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  const code = url.searchParams.get("code");
  if (!code) {
    return json(
      { error: "bad_request", message: "Missing auth code" },
      400,
    );
  }

  if (!supabaseAdmin) {
    return json(
      { error: "not_configured", message: "Supabase service role not configured" },
      503,
    );
  }
  const { data, error } = await supabaseAdmin.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    return json(
      { error: "auth_failed", message: error?.message ?? "Callback failed" },
      401,
    );
  }

  return json({
    ok: true,
    user: {
      id: data.user.id,
      email: data.user.email,
    },
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  });
};
