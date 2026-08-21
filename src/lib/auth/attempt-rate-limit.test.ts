import { afterEach, describe, expect, it } from "vitest";
import { __resetRateLimitForTests } from "@/lib/api/rate-limit";
import { AUTH_ATTEMPT_LIMIT, consumeAuthAttempt } from "./attempt-rate-limit";

describe("anonymous authentication attempt limiter", () => {
  afterEach(() => __resetRateLimitForTests());

  it("limits a burst from one forwarded client address", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.19, 10.0.0.1",
    });
    for (let attempt = 0; attempt < AUTH_ATTEMPT_LIMIT; attempt += 1) {
      expect(consumeAuthAttempt(headers)).toEqual({ ok: true });
    }
    expect(consumeAuthAttempt(headers)).toMatchObject({
      ok: false,
      retryAfterSeconds: expect.any(Number),
    });
  });

  it("does not let an oversized forwarded value create an unbounded key", () => {
    const oversized = new Headers({ "x-forwarded-for": "x".repeat(129) });
    for (let attempt = 0; attempt < AUTH_ATTEMPT_LIMIT; attempt += 1) {
      expect(consumeAuthAttempt(oversized)).toEqual({ ok: true });
    }
    expect(consumeAuthAttempt(new Headers())).toMatchObject({ ok: false });
  });
});
