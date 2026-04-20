/**
 * Lightweight in-process rate limiter for route handlers.
 *
 * Fixes part of INT-002 (code-council audit): `POST /api/team/accept-invite`
 * had no rate limit, so an authed attacker could brute-force the invite-token
 * namespace from a throwaway account. A fixed-window counter keyed by
 * `${ip}:${user.id}` is enough to turn a 1-qps brute-force into a 10-per-hour
 * trickle — more than generous for a real user.
 *
 * The state is kept in a module-scoped Map. On Vercel this is per-lambda,
 * which means a sufficiently determined attacker can still exceed the limit
 * by hitting cold regions. That's acceptable for the brute-force threat
 * (the attack surface is still ~10 * N-warm-lambdas, which is small for a
 * secret token) but is explicitly called out in the rollback notes as the
 * point where a Redis backend would be needed.
 *
 * The counter is a fixed window, not a sliding window — once a bucket hits
 * its reset time it zeroes out wholesale. For invite brute-force this is
 * the pessimal case for the attacker (at most `limit` requests in the few
 * seconds after a window boundary) and the friendliest for legitimate users.
 */

type Bucket = {
  /** Count of requests in the current window. */
  count: number;
  /** Epoch-millis at which the bucket resets to 0. */
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitResult =
  | { ok: true }
  | {
      ok: false;
      /** Seconds until the bucket resets and the caller can try again. */
      retryAfterSeconds: number;
    };

/**
 * Account for one request against the bucket identified by `key`.
 *
 * @param key       Opaque identifier for the bucket (e.g. `${ip}:${userId}`).
 * @param limit     Maximum requests permitted inside one window.
 * @param windowMs  Window length in milliseconds.
 * @param now       Injected clock for tests; defaults to `Date.now()`.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return { ok: true };
}

/** For tests only — flush all buckets so assertions start clean. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
