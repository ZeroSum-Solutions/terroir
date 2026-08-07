import { describe, expect, it } from "vitest";
import { resolveSampleRate } from "./sample-rate";

describe("resolveSampleRate", () => {
  it("accepts configured boundary values", () => {
    expect(resolveSampleRate("0", 0.1)).toBe(0);
    expect(resolveSampleRate("1", 0.1)).toBe(1);
    expect(resolveSampleRate("0.25", 0.1)).toBe(0.25);
  });

  it.each([undefined, "", "not-a-number", "-0.1", "1.1"])(
    "falls back for %s",
    (value) => {
      expect(resolveSampleRate(value, 0.1)).toBe(0.1);
    },
  );
});
