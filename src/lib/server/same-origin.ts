/**
 * Same-origin guard shared by the server endpoints.
 *
 * `sec-fetch-site` is the strongest signal when the browser sends it, but not
 * every client does. When it is absent (or "none", a direct navigation) the
 * Origin header is compared with the request URL; a request with no Origin at
 * all is allowed, because that is how a same-origin fetch and a `curl` call
 * look. A malformed Origin is rejected rather than thrown.
 */
export function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
