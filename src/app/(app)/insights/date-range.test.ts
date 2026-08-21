import { describe, expect, it } from "vitest";

import { normalizeInsightsRange } from "./date-range";

describe("normalizeInsightsRange", () => {
  it("keeps a complete valid custom range", () => {
    expect(
      normalizeInsightsRange(
        "custom",
        "2026-08-01",
        "2026-08-20",
        "2026-08-20",
      ),
    ).toEqual({
      range: "custom",
      from: "2026-08-01",
      to: "2026-08-20",
    });
  });

  it.each([
    ["malformed start", "custom", "not-a-date", "2026-08-20"],
    ["impossible start", "custom", "2026-02-30", "2026-03-01"],
    ["missing start", "custom", undefined, "2026-08-20"],
    ["inverted", "custom", "2026-08-20", "2026-08-01"],
    ["future end", "custom", "2026-08-01", "2026-08-21"],
    ["unsupported range", "unexpected", "2026-08-01", "2026-08-20"],
  ])("falls back to All for a %s URL", (_name, range, from, to) => {
    expect(normalizeInsightsRange(range, from, to, "2026-08-20")).toEqual({
      range: "all",
      from: undefined,
      to: undefined,
    });
  });

  it("drops stale custom dates from a preset range", () => {
    expect(
      normalizeInsightsRange(
        "30d",
        "2026-08-01",
        "2026-08-20",
        "2026-08-20",
      ),
    ).toEqual({ range: "30d", from: undefined, to: undefined });
  });
});
