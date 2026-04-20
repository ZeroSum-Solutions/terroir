/**
 * Module-scoped Anthropic client singleton.
 *
 * Fixes INT-007 (code-council audit): routes used to construct a new
 * `Anthropic()` client per request with default retry/timeout settings.
 * Under a slow upstream the SDK's default retry budget can exceed Vercel's
 * 120s route budget, causing the whole route to 504 before we get a chance
 * to return a clean error. Pinning `maxRetries: 2` + `timeout: 100_000`
 * keeps total latency under the platform ceiling.
 *
 * Cached at module scope so every import inside the same lambda invocation
 * reuses one client (and, because Vercel keeps lambdas warm, across
 * invocations too). The client is safe to share — it has no per-request
 * state.
 */
import Anthropic from "@anthropic-ai/sdk";

/** Max retries the SDK will perform on transient errors (429/5xx). */
const ANTHROPIC_MAX_RETRIES = 2;

/**
 * Hard ceiling for a single Anthropic request, in ms.
 * Kept under Vercel's 120s route budget (see `maxDuration = 120` in
 * `/api/scan/route.ts`) so we always have headroom to return an error
 * response instead of being killed by the platform.
 */
const ANTHROPIC_TIMEOUT_MS = 100_000;

let cachedClient: Anthropic | null = null;

/**
 * Return the shared Anthropic client. Reads `ANTHROPIC_API_KEY` on first
 * call; callers should still surface a friendly 500 when this throws.
 *
 * @throws {Error} when `ANTHROPIC_API_KEY` is not set.
 */
export function getAnthropicClient(): Anthropic {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY missing");
  }

  cachedClient = new Anthropic({
    apiKey,
    maxRetries: ANTHROPIC_MAX_RETRIES,
    timeout: ANTHROPIC_TIMEOUT_MS,
  });
  return cachedClient;
}

/** For tests only — forget the cached client so the next call re-reads env. */
export function __resetAnthropicClientForTests(): void {
  cachedClient = null;
}
