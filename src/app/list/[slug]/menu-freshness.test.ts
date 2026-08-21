import { describe, expect, it } from "vitest";
import { formatMenuFreshness, newestValidTimestamp } from "./menu-freshness";

describe("menu freshness", () => {
  it("uses the newest valid list or visible-item timestamp", () => {
    expect(
      newestValidTimestamp([
        "2026-08-18T10:00:00.000Z",
        "not-a-date",
        "2026-08-20T16:30:00.000Z",
        null,
      ]),
    ).toBe("2026-08-20T16:30:00.000Z");
  });

  it("returns null when every timestamp is missing or invalid", () => {
    expect(newestValidTimestamp([null, "bad"])).toBeNull();
  });

  it("formats a stable guest-facing freshness label", () => {
    expect(formatMenuFreshness("2026-08-20T16:30:00.000Z")).toBe(
      "Updated Aug 20, 2026",
    );
  });
});
