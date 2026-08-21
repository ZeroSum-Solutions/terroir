import { rateLimit, type RateLimitResult } from "@/lib/api/rate-limit";

export const AUTH_ATTEMPT_LIMIT = 5;
export const AUTH_ATTEMPT_WINDOW_MS = 60_000;

function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const candidate = forwarded?.split(",", 1)[0]?.trim();
  if (!candidate || candidate.length > 128) return "unknown";
  return candidate;
}

export function consumeAuthAttempt(headers: Headers): RateLimitResult {
  return rateLimit(
    `auth-attempt:${clientAddress(headers)}`,
    AUTH_ATTEMPT_LIMIT,
    AUTH_ATTEMPT_WINDOW_MS,
  );
}
