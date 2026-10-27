import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { supabaseAdmin } from "@/lib/auth/supabase-auth";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const { email, password, fullName } = body;

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
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName ?? "" },
  });

  if (error || !data.user) {
    return json(
      { error: "auth_failed", message: error?.message ?? "Signup failed" },
      400,
    );
  }

  return json({
    ok: true,
    user: {
      id: data.user.id,
      email: data.user.email,
    },
  });
};
