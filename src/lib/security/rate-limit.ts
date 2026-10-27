// KV-based rate limiter: 100 requests per minute per user.
//
// The user is identified by their connecting IP address
// (`request.cf.connectingIp`, falling back to `"anonymous"`). Each minute
// bucket is a KV key `rate-limit:<ip>:<unix-minute>` whose value is the
// request count. The key expires after 2 minutes so stale buckets are
// reclaimed automatically.
//
// Exceeding 100 requests in a minute returns a 429 response.

export interface RateLimitKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const MAX_REQUESTS_PER_MINUTE = 100;
const BUCKET_TTL_SECONDS = 120; // keys expire 2 minutes after being written

function currentMinuteKey(ip: string): string {
  const minute = Math.floor(Date.now() / 60_000);
  return `rate-limit:${ip}:${minute}`;
}

/**
 * Check and increment the rate-limit counter for the request's user.
 *
 * Returns `null` when the request is allowed, or a `Response` (429) when
 * the user has exceeded the limit. The caller should return the 429
 * response and not proceed with the request.
 */
export async function rateLimit(
  request: Request,
  kv: RateLimitKVNamespace,
): Promise<Response | null> {
  const ip = (request as { cf?: { connectingIp?: string } }).cf?.connectingIp ?? "anonymous";
  const key = currentMinuteKey(ip);

  let current = 0;
  try {
    const raw = await kv.get(key);
    if (raw !== null) {
      current = Number(raw) || 0;
    }
  } catch {
    // KV is unreachable — fail open rather than blocking all traffic.
    return null;
  }

  if (current >= MAX_REQUESTS_PER_MINUTE) {
    return new Response(
      JSON.stringify({
        error: "Too many requests. Slow down and try again later.",
        retryAfter: 60,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  try {
    await kv.put(key, String(current + 1), { expirationTtl: BUCKET_TTL_SECONDS });
  } catch {
    // KV write failed — fail open, allow the request.
  }

  return null;
}
