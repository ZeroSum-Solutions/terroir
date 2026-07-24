/**
 * Request-rate controls for route handlers.
 *
 * `enforceApiRateLimit` is the production control. It delegates to the
 * database so counters remain atomic across Railway restarts and replicas.
 * The legacy in-process `rateLimit` helper remains as a secondary IP/tenant
 * budget for the two routes that already use it; it is not the per-user gate.
 *
 * The persisted limiter derives its actor from `auth.uid()` and accepts only
 * hard-coded risk classes. A caller cannot raise its own ceiling by invoking
 * the RPC directly with arbitrary numeric limits.
 */

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Errors } from "./errors";
import { setRateLimitHeaders } from "./request-context";
import type { Database } from "@/types/database";

export const API_RATE_LIMIT_CLASSES = [
  "standard",
  "mutation",
  "expensive",
  "sensitive",
] as const;

export type ApiRateLimitClass = (typeof API_RATE_LIMIT_CLASSES)[number];

type PersistedRateLimitRow = {
  allowed: boolean;
  limit_count: number;
  remaining: number;
  retry_after_seconds: number;
  reset_at: string;
};

export async function enforceApiRateLimit(options: {
  supabase: SupabaseClient<Database>;
  riskClass: ApiRateLimitClass;
}): Promise<NextResponse | null> {
  const { data, error } = await options.supabase.rpc(
    "consume_api_rate_limit",
    { p_risk_class: options.riskClass },
  );
  if (error) throw error;

  const row = Array.isArray(data)
    ? (data[0] as unknown as PersistedRateLimitRow | undefined)
    : (data as unknown as PersistedRateLimitRow | null);
  const resetAtMs =
    row && typeof row.reset_at === "string"
      ? Date.parse(row.reset_at)
      : Number.NaN;
  if (
    !row ||
    typeof row.allowed !== "boolean" ||
    !Number.isInteger(row.limit_count) ||
    row.limit_count < 1 ||
    !Number.isInteger(row.remaining) ||
    row.remaining < 0 ||
    !Number.isInteger(row.retry_after_seconds) ||
    row.retry_after_seconds < 0 ||
    !Number.isFinite(resetAtMs)
  ) {
    throw new Error("consume_api_rate_limit returned an invalid result");
  }

  const resetSeconds = Math.max(
    1,
    Math.ceil((resetAtMs - Date.now()) / 1000),
  );
  const headers = {
    "RateLimit-Limit": String(row.limit_count),
    "RateLimit-Remaining": String(Math.max(0, row.remaining)),
    "RateLimit-Reset": String(resetSeconds),
  };
  setRateLimitHeaders(headers);

  if (row.allowed) return null;

  return Errors.rateLimited("Too many requests. Try again later.", {
    headers: {
      ...headers,
      "Retry-After": String(Math.max(1, row.retry_after_seconds)),
      "Cache-Control": "private, no-store",
    },
  });
}

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
