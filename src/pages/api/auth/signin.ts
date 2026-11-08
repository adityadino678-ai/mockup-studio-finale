import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";
import { sameOriginRequest } from "@/lib/server/same-origin";
import { z } from "zod";

export const prerender = false;

const bodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(72),
});

export const POST: APIRoute = async ({ request, locals }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "forbidden", message: "Cross-site requests are not allowed." }, 403);
  }

  const { client, admin } = authClients(locals);
  const supabase = client ?? admin;

  if (!supabase) {
    return json(
      { error: "not_configured", message: "Account sign-in is not configured on this deployment." },
      503,
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return json({ error: "bad_request", message: "Email and password are required." }, 400);
  }

  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error || !data.session) {
    // Pass Supabase's own reason through. "Email not confirmed" is the one the
    // visitor can act on, so do not flatten it into "invalid credentials".
    return json(
      { error: "auth_failed", message: error?.message ?? "Invalid email or password." },
      401,
    );
  }

  return json({
    ok: true,
    user: { id: data.user.id, email: data.user.email ?? "" },
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at ?? null,
  });
};
