// Security headers applied to every response.
//
// These are defence-in-depth headers that do not depend on request state:
//
//   X-Frame-Options: DENY             — never allow clickframing
//   X-Content-Type-Options: nosniff   — prevent MIME-type sniffing
//   Referrer-Policy: strict-origin-when-cross-origin
//   Permissions-Policy:               — disable camera/microphone/geolocation
//   Cache-Control: no-store           — API responses are never cached

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), " +
    "magnetometer=(), gyroscope=(), accelerometer=()",
};

/** Apply security headers to a Response (mutates headers in place). */
export function applySecurityHeaders(response: Response): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
}

/** Apply no-store cache control to a Response (API responses must never be cached). */
export function applyNoStore(response: Response): void {
  response.headers.set("Cache-Control", "no-store, no-transform");
}
