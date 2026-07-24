import { describe, expect, it } from "vitest";
import {
  readApiErrorCode,
  shouldRetainIdempotencyKey,
} from "./idempotency-client";

describe("idempotency client retry policy", () => {
  it("reads only nested standard error codes", () => {
    expect(
      readApiErrorCode({
        error: { code: "idempotency_in_progress", message: "Wait." },
      }),
    ).toBe("idempotency_in_progress");
    expect(readApiErrorCode({ error: "legacy" })).toBeNull();
    expect(readApiErrorCode(null)).toBeNull();
  });

  it.each([408, 429, 500, 503])(
    "retains a logical request key for transient status %s",
    (status) => {
      expect(shouldRetainIdempotencyKey(status, null)).toBe(true);
    },
  );

  it.each([
    "idempotency_in_progress",
    "idempotency_outcome_unknown",
    "idempotency_unavailable",
  ])("retains a key for %s", (code) => {
    expect(shouldRetainIdempotencyKey(409, code)).toBe(true);
  });

  it.each([
    [400, "validation_error"],
    [404, "not_found"],
    [409, "idempotency_key_reused"],
    [422, "unprocessable"],
  ] as const)("clears a key for deterministic %s %s", (status, code) => {
    expect(shouldRetainIdempotencyKey(status, code)).toBe(false);
  });
});
