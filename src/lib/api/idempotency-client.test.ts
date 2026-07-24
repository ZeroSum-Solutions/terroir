import { describe, expect, it } from "vitest";
import {
  createBinaryCommandFingerprint,
  createIdempotencyKey,
  readApiErrorCode,
  shouldRetainIdempotencyKey,
} from "./idempotency-client";

describe("idempotency client retry policy", () => {
  it("creates a valid opaque logical-action key", () => {
    expect(createIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("fingerprints ordered binary bytes and canonical metadata", async () => {
    const left = await createBinaryCommandFingerprint(
      { z: 2, a: 1 },
      new Uint8Array([1, 2]),
      new Blob(["wine"]),
    );
    const reordered = await createBinaryCommandFingerprint(
      { a: 1, z: 2 },
      new Uint8Array([1, 2]),
      new Blob(["wine"]),
    );
    const changed = await createBinaryCommandFingerprint(
      { a: 1, z: 2 },
      new Uint8Array([2, 1]),
      new Blob(["wine"]),
    );

    expect(left).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(left);
    expect(changed).not.toBe(left);
  });

  it("reads only nested standard error codes", () => {
    expect(
      readApiErrorCode({
        error: { code: "idempotency_in_progress", message: "Wait." },
      }),
    ).toBe("idempotency_in_progress");
    expect(readApiErrorCode({ error: "legacy" })).toBeNull();
    expect(readApiErrorCode(null)).toBeNull();
  });

  it.each([408, 425, 429, 500, 503])(
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
