/**
 * Auth middleware for API endpoints.
 *
 * Checks for a valid Supabase JWT in the Authorization header or
 * x-access-token header. Returns the user object or a 401 response.
 *
 * Clients are resolved per request (see `server.ts`): a module-level client
 * would be created before the Workers binding exists and would always be null
 * on the deployed Worker.
 */

import { json } from "@/lib/server/env";
import { authClients } from "@/lib/auth/server";

export interface AuthContext {
  userId: string;
  email: string;
  accessToken: string;
}

export async function requireAuth(
  request: Request,
  locals?: unknown,
): Promise<AuthContext | Response> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : request.headers.get("x-access-token") ?? "";

  if (!token) {
    return json({ error: "unauthorized", message: "Missing auth token" }, 401);
  }

  const { client, admin } = authClients(locals);
  const supabase = client ?? admin;

  if (!supabase) {
    return json({ error: "not_configured", message: "Supabase Auth is not configured." }, 503);
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return json({ error: "unauthorized", message: "Invalid or expired token" }, 401);
  }

  return {
    userId: data.user.id,
    email: data.user.email ?? "",
    accessToken: token,
  };
}
