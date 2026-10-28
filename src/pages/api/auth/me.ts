import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { createSupabaseClients, type SupabaseEnv } from "@/lib/auth/supabase-client";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Partial<SupabaseEnv> } }).runtime?.env ?? {};
  const { client } = createSupabaseClients(env as SupabaseEnv);

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : request.headers.get("x-access-token") ?? "";

  if (!token) {
    return json(
      { error: "unauthorized", message: "Missing auth token" },
      401,
    );
  }

  if (!client) {
    return json(
      { error: "not_configured", message: "Supabase not configured" },
      503,
    );
  }

  const { data, error } = await client.auth.getUser(token);

  if (error || !data.user) {
    return json(
      { error: "unauthorized", message: "Invalid or expired token" },
      401,
    );
  }

  return json({
    user: {
      id: data.user.id,
      email: data.user.email ?? "",
    },
  });
};
