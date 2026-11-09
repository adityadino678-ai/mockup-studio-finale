"use client";

/**
 * Browser-side auth using the app's own /api/auth/* endpoints.
 *
 * The browser calls the server endpoints, which talk to Supabase server-side.
 * The returned JWT is stored in localStorage and sent with subsequent requests
 * via the Authorization header. Nothing about the library changes: the tools
 * stay login-free and the workspace stays in IndexedDB.
 */

const TOKEN_KEY = "mockup-studio:auth-token";

export function getAuthToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}

export interface AuthStatus {
  configured: boolean;
  serviceRole: boolean;
  signupMode: "disabled" | "instant" | "email-confirmation";
}

/** Whether this deployment has auth at all, and which sign-up path it uses. */
export async function authStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status");
  if (!res.ok) {
    return { configured: false, serviceRole: false, signupMode: "disabled" };
  }
  return res.json();
}

export async function signIn(email: string, password: string) {
  const res = await fetch("/api/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessToken) {
    throw new Error(data.message ?? "Sign in failed");
  }
  setAuthToken(data.accessToken);
  return { user: data.user, accessToken: data.accessToken };
}

export async function signUp(email: string, password: string, fullName?: string) {
  const res = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, fullName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.user) {
    throw new Error(data.message ?? "Sign up failed");
  }
  return {
    user: data.user as { id: string; email: string },
    /** True when Supabase sent a confirmation mail and no session exists yet. */
    needsEmailConfirmation: Boolean(data.needsEmailConfirmation),
    mode: (data.mode ?? "email-confirmation") as "instant" | "email-confirmation",
  };
}

export async function signOut() {
  clearAuthToken();
}

export async function getSession() {
  const token = getAuthToken();
  if (!token) return null;

  const res = await fetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    clearAuthToken();
    return null;
  }
  return res.json();
}
