/**
 * The public origin for canonical / Open Graph URLs.
 *
 * This is strictly opt-in: no custom domain exists yet, so `PUBLIC_SITE_URL` is
 * unset in production today and every caller emits nothing. The value is read
 * lazily at the moment a page renders (build time for these static pages), so
 * setting the variable is the only switch - no fallback to the request URL is
 * ever made.
 *
 * A `*.workers.dev` host is deliberately rejected. The Worker's temporary
 * hostname is not the product's address: pointing a canonical or `og:url` at it
 * would advertise a URL that is expected to change, and would compete with the
 * real domain in search. A deceptive host such as `https://x.workers.dev.evil.com`
 * is NOT a workers.dev host and is accepted - only the actual hostname suffix is
 * checked, never a substring of the whole URL.
 */

/** Anything under this suffix is a Cloudflare-assigned temporary hostname. */
const WORKERS_DEV_SUFFIX = ".workers.dev";

/**
 * Normalise a configured origin to `https://host[:port]`, or return `null`.
 *
 * Rules, in order:
 * - trim, and reject an empty value;
 * - require a parseable absolute URL;
 * - require `https:` (plain `http:` is rejected);
 * - reject a host that is `workers.dev` or ends in `.workers.dev`;
 * - return the origin only, dropping any path, query and hash, with no trailing
 *   slash.
 */
export function normaliseSiteUrl(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  if (host === "workers.dev" || host.endsWith(WORKERS_DEV_SUFFIX)) return null;

  // `origin` keeps the port but never the path, query or hash, and has no
  // trailing slash for a root URL.
  return url.origin;
}

/** The configured public origin, or `null` when the opt-in is not set. */
export function publicSiteUrl(): string | null {
  return normaliseSiteUrl(import.meta.env.PUBLIC_SITE_URL);
}

/**
 * Build an absolute URL for `path` on the public origin.
 *
 * Returns `null` when no valid `PUBLIC_SITE_URL` is configured, which is what
 * keeps canonical / `og:url` tags absent today. `path` is always treated as a
 * path: it is prefixed with `/` and duplicate slashes are collapsed, so both
 * `/mockups` and `mockups` resolve to the same URL.
 */
export function absoluteUrl(path: string): string | null {
  const site = publicSiteUrl();
  if (!site) return null;

  const suffix = `/${path.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  return `${site}${suffix}`;
}
