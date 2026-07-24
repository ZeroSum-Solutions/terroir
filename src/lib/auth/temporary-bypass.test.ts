import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidTemporaryBypassToken } from "./temporary-bypass";

const TOKEN_HASH =
  "fcc10d33162838e7b9e468c681194474d040cd9844c9e8c69f11e0e1aa0d8010";
const FUTURE_EXPIRY = "2026-07-23T12:05:00.000Z";

describe("isValidTemporaryBypassToken", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a raw token matching the configured hash before expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));

    expect(
      isValidTemporaryBypassToken(
        TOKEN_HASH.toUpperCase(),
        FUTURE_EXPIRY,
        "temporary-secret",
      ),
    ).toBe(true);
    expect(
      isValidTemporaryBypassToken(
        TOKEN_HASH,
        FUTURE_EXPIRY,
        "temporary-secret",
      ),
    ).toBe(true);
  });

  it("rejects an old or otherwise incorrect raw token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));

    expect(
      isValidTemporaryBypassToken(TOKEN_HASH, FUTURE_EXPIRY, "old-token"),
    ).toBe(false);
    expect(
      isValidTemporaryBypassToken(TOKEN_HASH, FUTURE_EXPIRY, "wrong-token"),
    ).toBe(false);
    expect(
      isValidTemporaryBypassToken(TOKEN_HASH, FUTURE_EXPIRY, null),
    ).toBe(false);
  });

  it("rejects missing or invalid configured hashes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));

    expect(
      isValidTemporaryBypassToken(
        undefined,
        FUTURE_EXPIRY,
        "temporary-secret",
      ),
    ).toBe(false);
    expect(
      isValidTemporaryBypassToken(
        "temporary-secret",
        FUTURE_EXPIRY,
        "temporary-secret",
      ),
    ).toBe(false);
    expect(
      isValidTemporaryBypassToken(
        `${TOKEN_HASH.slice(0, -1)}g`,
        FUTURE_EXPIRY,
        "temporary-secret",
      ),
    ).toBe(false);
  });

  it("rejects missing, invalid, and expired configured timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    expect(
      isValidTemporaryBypassToken(
        TOKEN_HASH,
        undefined,
        "temporary-secret",
      ),
    ).toBe(false);
    expect(
      isValidTemporaryBypassToken(
        TOKEN_HASH,
        "not-an-iso-timestamp",
        "temporary-secret",
      ),
    ).toBe(false);
    expect(
      isValidTemporaryBypassToken(
        TOKEN_HASH,
        "2026-02-30T12:00:00.000Z",
        "temporary-secret",
      ),
    ).toBe(false);

    vi.setSystemTime(new Date("2026-07-23T12:05:00.000Z"));
    expect(
      isValidTemporaryBypassToken(
        TOKEN_HASH,
        FUTURE_EXPIRY,
        "temporary-secret",
      ),
    ).toBe(false);
  });
});
