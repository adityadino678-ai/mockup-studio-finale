import { cspHeader, makeNonce } from "@/lib/security/csp";
import { applySecurityHeaders, applyNoStore } from "@/lib/security/headers";
import { rateLimit, type RateLimitKVNamespace } from "@/lib/security/rate-limit";

/** Paths that are mutating (write/side-effect) endpoints — rate limited. */
const MUTATING_PATHS = [
  "/api/printify/products",
  "/api/printify/publish",
  "/api/printify/mockups",
  "/api/etsy/research",
  "/api/ai/assistant",
  "/api/ai/chat",
  "/api/ai/seo",
  "/api/ai/title",
  "/api/integrations/models",
  "/api/integrations/test",
];

/** Is this request for a mutating API endpoint? */
function isMutatingApi(pathname: string, method: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return MUTATING_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

interface MiddlewareContext {
  request: Request;
  locals: { RATE_LIMIT_KV?: unknown } & Record<string, unknown>;
  [key: string]: unknown;
}

export const onRequest = async (context: MiddlewareContext, next: () => Promise<Response>) => {
  const { request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // --- rate limiting for mutating API endpoints ---------------------------
  if (isMutatingApi(pathname, request.method)) {
    const kv = context.locals.RATE_LIMIT_KV;
    if (kv && typeof kv === "object" && "get" in kv && "put" in kv) {
      const limited = await rateLimit(request, kv as RateLimitKVNamespace);
      if (limited) return limited;
    }
  }

  const nonce = makeNonce();
  const response = await next();

  // --- security headers on every response ---------------------------------
  applySecurityHeaders(response);

  // --- CSP header on every response ---------------------------------------
  response.headers.set("Content-Security-Policy", cspHeader(nonce));

  // --- no-store for API responses -----------------------------------------
  if (pathname.startsWith("/api/")) {
    applyNoStore(response);
  }

  // --- inject nonce into inline scripts in HTML responses -----------------
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const html = await response.text();
    const modified = html.replace(
      /<script\b([^>]*)>/gi,
      (_match: string, attrs: string) => {
        // Skip scripts that already have a nonce or are external (src=)
        if (/\bnonce\s*=/i.test(attrs) || /\bsrc\s*=/i.test(attrs)) {
          return `<script${attrs}>`;
        }
        return `<script nonce="${nonce}"${attrs}>`;
      },
    );
    return new Response(modified, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return response;
};
