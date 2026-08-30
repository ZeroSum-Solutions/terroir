// The revert success panel's copy. This used to be a module-private helper
// inside import-client.tsx, observable only by rendering BatchStep and
// driving a revert through mocked fetch.
import { describe, expect, it } from "vitest";
import { summarizeRevertResult, type RevertResult } from "./revert-summary";

function result(overrides: Partial<RevertResult> = {}): RevertResult {
  return {
    revertedCount: 3,
    orphanWinesDeleted: 1,
    lwinStampsCleared: 2,
    cleanupTruncated: false,
    orphanCleanupSkipped: false,
    cleanupFailures: 0,
    ...overrides,
  };
}

describe("summarizeRevertResult", () => {
  it("reports the three counts and nothing else on a clean revert", () => {
    const copy = summarizeRevertResult(result());
    expect(copy).toContain("Removed 3 inventory row(s)");
    expect(copy).toContain("deleted 1 wine(s)");
    expect(copy).toContain("cleared 2 wine-catalog (LWIN) link(s)");
    expect(copy).not.toContain("runbook");
  });

  it("composes every partial-cleanup notice instead of dropping all but one", () => {
    const copy = summarizeRevertResult(
      result({ cleanupTruncated: true, orphanCleanupSkipped: true, cleanupFailures: 4 }),
    );
    expect(copy).toContain("Orphan-wine cleanup was skipped");
    expect(copy).toContain("didn't finish in time");
    expect(copy).toContain("Some cleanup steps failed");
  });

  it("says nothing about failures when the count is zero", () => {
    expect(summarizeRevertResult(result({ cleanupFailures: 0 }))).not.toContain("Some cleanup steps failed");
  });

  it("never suggests reverting again — the batch is already reverted", () => {
    const copy = summarizeRevertResult(result({ cleanupTruncated: true }));
    expect(copy.toLowerCase()).not.toContain("try again");
    expect(copy.toLowerCase()).not.toContain("revert again");
  });
});
