// Content Security Policy configuration.
//
// Strict nonce-based policy: every inline script must carry a per-request
// nonce that matches the `script-src` directive. Scripts loaded by a
// nonce'd script are trusted via `strict-dynamic`, so external scripts
// fetched from allowed origins do not need a nonce.
//
// connect-src is limited to the origins the app actually talks to:
//   - self (same-origin API endpoints)
//   - api.printify.com (Printify REST API)
//   - *.supabase.co + wss://*.supabase.co (realtime / edge functions)
//
// `base-uri 'self'` and `frame-ancestors 'none'` are defence in depth.
//
// `crypto.getRandomValues` is available globally in the Workers runtime
// and in modern browsers; no import is needed.

const ALLOWED_CONNECT_SRC = [
  "'self'",
  "https://api.printify.com",
  "https://*.supabase.co",
  "wss://*.supabase.co",
].join(" ");

/** Generate a per-request nonce (base64url, no padding). */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64url without padding
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build the Content-Security-Policy header value for a given nonce.
 *
 * `script-src` uses `nonce-...` + `strict-dynamic` so that:
 *   * inline scripts must carry the matching `nonce` attribute;
 *   * scripts dynamically imported by a trusted script are allowed.
 * `object-src 'none'` blocks plugins. `base-uri 'self'` blocks
 *   `<base>` hijacking. `frame-ancestors 'none'` is clickjacking defence.
 */
export function cspHeader(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'nonce-${nonce}' 'strict-dynamic' https:`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`, // Tailwind inline styles + Google Fonts CSS
    `img-src 'self' data: blob: https:`,
    `connect-src ${ALLOWED_CONNECT_SRC}`,
    `font-src 'self' https://fonts.gstatic.com`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `upgrade-insecure-requests`,
  ].join("; ");
}
