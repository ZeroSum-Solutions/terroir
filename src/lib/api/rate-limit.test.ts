import { beforeEach, describe, expect, it } from "vitest";
import { __resetRateLimitForTests, rateLimit } from "./rate-limit";

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
