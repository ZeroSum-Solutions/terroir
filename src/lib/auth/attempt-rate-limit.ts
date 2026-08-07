import { rateLimit, type RateLimitResult } from "@/lib/api/rate-limit";

export const AUTH_ATTEMPT_LIMIT = 5;
export const AUTH_ATTEMPT_WINDOW_MS = 60_000;

function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const candidate = forwarded?.split(",", 1)[0]?.trim();
  if (!candidate || candidate.length > 128) return "unknown";
  return candidate;
}

/**
 * Secondary burst control for anonymous auth requests. Supabase's configured
 * auth email limits remain the distributed primary control; this stops a burst
 * before one app instance repeatedly calls the provider.
 */
export function consumeAuthAttempt(headers: Headers): RateLimitResult {
  return rateLimit(
    `auth-attempt:${clientAddress(headers)}`,
    AUTH_ATTEMPT_LIMIT,
    AUTH_ATTEMPT_WINDOW_MS,
  );
}
