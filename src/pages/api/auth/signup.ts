import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { createSupabaseClients, type SupabaseEnv } from "@/lib/auth/supabase-client";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Partial<SupabaseEnv> } }).runtime?.env ?? {};
  const { admin } = createSupabaseClients(env as SupabaseEnv);

  const body = await request.json().catch(() => ({}));
  const { email, password, fullName } = body;

  if (!email || !password) {
    return json(
      { error: "bad_request", message: "Email and password required" },
      400,
    );
  }

  if (!admin) {
    return json(
      { error: "not_configured", message: "Supabase service role not configured" },
      503,
    );
  }

  const { data, error } = await admin.auth.admin.createUser({
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
