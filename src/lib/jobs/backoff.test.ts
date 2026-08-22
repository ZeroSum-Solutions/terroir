import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "@/lib/jobs/backoff";
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS } from "@/lib/jobs/constants";

describe("computeBackoffMs", () => {
  it("returns the base delay for the first attempt", () => {
    expect(computeBackoffMs(1)).toBe(BASE_BACKOFF_MS);
  });

  it("doubles per subsequent attempt", () => {
    expect(computeBackoffMs(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(computeBackoffMs(3)).toBe(BASE_BACKOFF_MS * 4);
  });

  it("caps at the max backoff", () => {
    expect(computeBackoffMs(20)).toBe(MAX_BACKOFF_MS);
  });

  it("never returns less than the base delay, even for attempt 0", () => {
    expect(computeBackoffMs(0)).toBe(BASE_BACKOFF_MS);
  });
});
