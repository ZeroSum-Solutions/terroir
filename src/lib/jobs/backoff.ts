import { BASE_BACKOFF_MS, MAX_BACKOFF_MS } from "@/lib/jobs/constants";

/**
 * Exponential backoff for the Nth failed attempt (1-indexed: the attempt
 * that just failed). Deterministic (no jitter) so retry timing is testable;
 * jitter can be added later if thundering-herd retries become a real
 * problem, but isn't needed for a single worker process.
 */
export function computeBackoffMs(attemptNumber: number): number {
  const exponent = Math.max(0, attemptNumber - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}
