import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { supabaseAdmin } from "@/lib/auth/supabase-auth";
import { requireAuth } from "@/lib/auth/middleware";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => ({}));
  const { email, password } = body;

  if (!email || !password) {
    return json(
      { error: "bad_request", message: "Email and password required" },
      400,
    );
  }

  if (!supabaseAdmin) {
    return json(
      { error: "not_configured", message: "Supabase service role not configured" },
      503,
    );
  }
  const { data, error } = await supabaseAdmin.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.session) {
    return json(
      {
        error: "auth_failed",
        message: error?.message ?? "Invalid credentials",
      },
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
