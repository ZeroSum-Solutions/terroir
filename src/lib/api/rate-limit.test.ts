import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";
import {
  __resetRateLimitForTests,
  enforceApiRateLimit,
  rateLimit,
} from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
  });

  it("allows the first N requests, blocks the (N+1)th within the window", () => {
    const KEY = "1.2.3.4:user-abc";
    const LIMIT = 10;
    const WINDOW = 60_000;
    const T0 = 1_000_000;

    // Ten calls — all ok.
    for (let i = 0; i < LIMIT; i++) {
      expect(rateLimit(KEY, LIMIT, WINDOW, T0 + i).ok).toBe(true);
    }
    // Eleventh — blocked.
    const blocked = rateLimit(KEY, LIMIT, WINDOW, T0 + LIMIT);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("resets the bucket once the window has passed", () => {
    const KEY = "k";
    const LIMIT = 3;
    const WINDOW = 1_000;
    // Fill the bucket.
    expect(rateLimit(KEY, LIMIT, WINDOW, 0).ok).toBe(true);
    expect(rateLimit(KEY, LIMIT, WINDOW, 10).ok).toBe(true);
    expect(rateLimit(KEY, LIMIT, WINDOW, 20).ok).toBe(true);
    expect(rateLimit(KEY, LIMIT, WINDOW, 30).ok).toBe(false);
    // Jump past the window.
    expect(rateLimit(KEY, LIMIT, WINDOW, 2_000).ok).toBe(true);
  });

  it("keeps separate buckets for separate keys", () => {
    const LIMIT = 2;
    const WINDOW = 60_000;
    // Key A uses both its slots.
    expect(rateLimit("a", LIMIT, WINDOW, 0).ok).toBe(true);
    expect(rateLimit("a", LIMIT, WINDOW, 1).ok).toBe(true);
    expect(rateLimit("a", LIMIT, WINDOW, 2).ok).toBe(false);
    // Key B is untouched.
    expect(rateLimit("b", LIMIT, WINDOW, 3).ok).toBe(true);
    expect(rateLimit("b", LIMIT, WINDOW, 4).ok).toBe(true);
    expect(rateLimit("b", LIMIT, WINDOW, 5).ok).toBe(false);
  });

  it("reports a retry-after that shrinks as the window elapses", () => {
    const KEY = "k";
    const LIMIT = 1;
    const WINDOW = 60_000;
    // First call opens a bucket that resets at T0 + 60_000.
    expect(rateLimit(KEY, LIMIT, WINDOW, 0).ok).toBe(true);
    const early = rateLimit(KEY, LIMIT, WINDOW, 100);
    const late = rateLimit(KEY, LIMIT, WINDOW, 59_000);
    expect(early.ok).toBe(false);
    expect(late.ok).toBe(false);
    if (!early.ok && !late.ok) {
      expect(late.retryAfterSeconds).toBeLessThan(early.retryAfterSeconds);
    }
  });
});

describe("enforceApiRateLimit", () => {
  it("uses the persisted class bucket and allows requests with capacity", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          allowed: true,
          limit_count: 60,
          remaining: 59,
          retry_after_seconds: 0,
          reset_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      error: null,
    });

    await expect(
      enforceApiRateLimit({
        supabase: { rpc } as unknown as SupabaseClient<Database>,
        riskClass: "mutation",
      }),
    ).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith("consume_api_rate_limit", {
      p_risk_class: "mutation",
    });
  });

  it("returns the standard 429 envelope and quota headers when exhausted", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          allowed: false,
          limit_count: 10,
          remaining: 0,
          retry_after_seconds: 17,
          reset_at: new Date(Date.now() + 17_000).toISOString(),
        },
      ],
      error: null,
    });

    const response = await enforceApiRateLimit({
      supabase: { rpc } as unknown as SupabaseClient<Database>,
      riskClass: "expensive",
    });

    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("17");
    expect(response?.headers.get("RateLimit-Limit")).toBe("10");
    expect(response?.headers.get("RateLimit-Remaining")).toBe("0");
    await expect(response?.json()).resolves.toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again later.",
      },
    });
  });

  it("fails closed when the shared counter is unavailable", async () => {
    const providerError = { code: "08006", message: "database unavailable" };
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: providerError });

    await expect(
      enforceApiRateLimit({
        supabase: { rpc } as unknown as SupabaseClient<Database>,
        riskClass: "standard",
      }),
    ).rejects.toBe(providerError);
  });

  it("fails closed when the shared counter returns malformed metadata", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          allowed: true,
          limit_count: 120,
          remaining: -1,
          retry_after_seconds: 0,
          reset_at: "not-a-timestamp",
        },
      ],
      error: null,
    });

    await expect(
      enforceApiRateLimit({
        supabase: { rpc } as unknown as SupabaseClient<Database>,
        riskClass: "standard",
      }),
    ).rejects.toThrow("consume_api_rate_limit returned an invalid result");
  });
});
