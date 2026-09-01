// Issue #101 (G1-12 round-2 critic review, PR #95): invoice_scans.status
// gained a "review" value (arithmetic mismatch after retry) that this
// module's status vocabulary never learned about — parseStatus dropped it
// back to "all", the chip set had nothing to select it with, and
// statusLabel/statusBadge only reached it by accident through their
// generic fallback. This suite pins "review" as a first-class member of
// the vocabulary, not a coincidence of the default case.
import { describe, expect, it } from "vitest";
import {
  parseStatus,
  statusBadge,
  statusLabel,
  STATUS_FILTERS,
  type StatusFilter,
} from "./scan-list-status";

describe("StatusFilter vocabulary", () => {
  it("STATUS_FILTERS carries a review chip, once, with copy naming what it is", () => {
    const review = STATUS_FILTERS.filter((f) => f.value === "review");
    expect(review).toHaveLength(1);
    expect(review[0].label).toBe("Review");
  });

  it("parseStatus accepts 'review' from the querystring instead of falling back to 'all'", () => {
    expect(parseStatus("review")).toBe("review");
  });

  it("parseStatus still rejects unknown values", () => {
    expect(parseStatus("bogus")).toBe("all");
    expect(parseStatus(undefined)).toBe("all");
  });

  it("statusLabel names a review row 'Review'", () => {
    expect(statusLabel("review")).toBe("Review");
  });

  it("statusBadge gives review its own styling, consistent with the confidence gate's arithmetic-mismatch treatment (risk tokens), not the neutral fallback", () => {
    expect(statusBadge("review")).toBe("bg-risk-wash text-risk-ink");
    expect(statusBadge("review")).not.toBe(statusBadge("unrecognised-status"));
  });

  it("every StatusFilter value used elsewhere in the union round-trips through the chip set", () => {
    const values: StatusFilter[] = ["all", "complete", "processing", "review", "failed"];
    for (const value of values) {
      if (value === "all") continue;
      expect(STATUS_FILTERS.some((f) => f.value === value)).toBe(true);
    }
  });
});
