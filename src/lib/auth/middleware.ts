/**
 * Auth middleware for API endpoints.
 *
 * Checks for a valid Supabase JWT in the Authorization header or
 * x-access-token header. Returns the user object or a 401 response.
 */

import { json } from "@/lib/server/env";
import { supabase } from "@/lib/auth/supabase-auth";

export interface AuthContext {
  userId: string;
  email: string;
  accessToken: string;
}

export async function requireAuth(
  request: Request,
): Promise<AuthContext | Response> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : request.headers.get("x-access-token") ?? "";

  if (!token) {
    return json({ error: "unauthorized", message: "Missing auth token" }, 401);
  }

  // Verify the token with Supabase
  if (!supabase) {
    return json(
      { error: "not_configured", message: "Supabase not configured" },
      503,
    );
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return json(
      { error: "unauthorized", message: "Invalid or expired token" },
      401,
    );
  }

  return {
    userId: data.user.id,
    email: data.user.email ?? "",
    accessToken: token,
  };
}
