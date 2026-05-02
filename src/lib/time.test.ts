import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeAgo } from "./time";

const NOW = new Date("2026-05-01T12:00:00.000Z").getTime();

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders 'Just now' for diffs under 60 seconds", () => {
    expect(timeAgo(isoAgo(0))).toBe("Just now");
    expect(timeAgo(isoAgo(30_000))).toBe("Just now");
    expect(timeAgo(isoAgo(59_999))).toBe("Just now");
  });

  it("clamps future timestamps to 'Just now' rather than negative values", () => {
    expect(timeAgo(new Date(NOW + 5_000).toISOString())).toBe("Just now");
  });

  it("uses minutes between 1m and 59m", () => {
    expect(timeAgo(isoAgo(60_000))).toBe("1m ago");
    expect(timeAgo(isoAgo(45 * 60_000))).toBe("45m ago");
  });

  it("uses hours between 1h and 23h", () => {
    expect(timeAgo(isoAgo(60 * 60_000))).toBe("1h ago");
    expect(timeAgo(isoAgo(23 * 60 * 60_000))).toBe("23h ago");
  });

  it("uses days between 1d and 6d", () => {
    expect(timeAgo(isoAgo(24 * 60 * 60_000))).toBe("1d ago");
    expect(timeAgo(isoAgo(6 * 24 * 60 * 60_000))).toBe("6d ago");
  });

  it("uses weeks at 7+ days", () => {
    expect(timeAgo(isoAgo(7 * 24 * 60 * 60_000))).toBe("1w ago");
    expect(timeAgo(isoAgo(30 * 24 * 60 * 60_000))).toBe("4w ago");
  });
});
