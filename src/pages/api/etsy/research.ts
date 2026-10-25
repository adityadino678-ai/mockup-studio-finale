import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { EtsyApiError, searchEtsyActiveListings } from "@/lib/server/etsy";
import type { EtsyResearch, EtsyResearchResponse } from "@/types/etsy";

/**
 * A tiny in-isolate cache. The same query is often needed by several listings
 * in one autopilot run, and Etsy's public limits are low; ten minutes keeps a
 * run honest without hammering the API.
 *
 * This is deliberately not a database. Nothing about the user's shop or
 * listings is stored here, only public search results.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 24;
const cache = new Map<string, { at: number; research: EtsyResearch }>();

function cached(query: string): EtsyResearch | undefined {
  const key = query.trim().toLowerCase();
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.research;
}

function remember(query: string, research: EtsyResearch): void {
  const key = query.trim().toLowerCase();
  cache.set(key, { at: Date.now(), research });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

/**
 * Read-only endpoint, but it spends the operator's Etsy keystring and is not
 * meant for other sites. This is the same guard the Printify write endpoints
 * use: a cross-site request is refused even when it skips preflight.
 */
function sameOriginRequest(request: Request): boolean {
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

function cleanQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const query = value.trim().replace(/\s+/g, " ");
  if (query.length < 2 || query.length > 120) return undefined;
  return query;
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-site requests are not allowed on this endpoint." }, 403);
  }
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Could not read the request body" }, 400);
  }
  // A research query is a sentence or two. Refuse an unbounded body before
  // parsing it.
  if (raw.length > 8_192) {
    return json({ error: "The research request is too large" }, 413);
  }

  let body: { query?: unknown };
  try {
    body = JSON.parse(raw) as { query?: unknown };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const query = cleanQuery(body.query);
  if (!query) {
    return json({ error: "A research query of 2 to 120 characters is required" }, 400);
  }

  const creds = credentialsFromRequest(request);
  if (!creds.etsy) {
    const payload: EtsyResearchResponse = {
      configured: false,
      error:
        "Etsy research needs a developer keystring. Add one in Settings → API connections, or set ETSY_API_KEY on the server.",
    };
    return json(payload, 503);
  }

  const hit = cached(query);
  if (hit) {
    return json({ configured: true, research: hit, cached: true } satisfies EtsyResearchResponse & {
      cached: boolean;
    });
  }

  try {
    const research = await searchEtsyActiveListings(creds.etsy.apiKey, query);
    remember(query, research);
    return json({ configured: true, research, cached: false } satisfies EtsyResearchResponse & {
      cached: boolean;
    });
  } catch (error) {
    if (error instanceof EtsyApiError) {
      if (error.status === 401 || error.status === 403) {
        const payload: EtsyResearchResponse = {
          configured: false,
          error: error.message,
        };
        return json(payload, 503);
      }
      return json({ error: error.message }, error.status === 429 ? 429 : 502);
    }
    return json(
      { error: error instanceof Error ? error.message : "Etsy research failed" },
      502,
    );
  }
};
