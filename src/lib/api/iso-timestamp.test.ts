import { describe, expect, it } from "vitest";
import { normalizeIsoUtcTimestamp } from "./iso-timestamp";

describe("normalizeIsoUtcTimestamp", () => {
  it.each([
    [
      "2026-07-24T02:03:04-07:00",
      "2026-07-24T09:03:04.000000Z",
    ],
    [
      "2026-07-24T02:03:04.1-07:00",
      "2026-07-24T09:03:04.100000Z",
    ],
    [
      "2026-07-24T09:03:04.123456+00:00",
      "2026-07-24T09:03:04.123456Z",
    ],
    [
      "2026-07-24T23:03:04.654321-07:00",
      "2026-07-25T06:03:04.654321Z",
    ],
  ])("normalizes %s without dropping microseconds", (input, expected) => {
    expect(normalizeIsoUtcTimestamp(input)).toBe(expected);
  });

  it.each([
    "2026-07-24T09:03:04",
    "not-a-date",
    "2026-07-24T09:03:04.1234567Z",
  ])("rejects unsupported timestamp %s", (input) => {
    expect(() => normalizeIsoUtcTimestamp(input)).toThrow(TypeError);
  });
});
