// The file-size ratchet runs two budgets, and this pins which file gets which.
//
// One budget could not serve both: a table-driven test suite is legitimately
// long — its length is cases, not tangled logic — while a 500-line React
// component is the monolith the gate exists to catch. Holding tests to the
// source budget taught the wrong lesson (delete cases to go green), so tests
// get room and application code keeps the tighter limit it always had.
//
// The classification is deliberately the narrowest thing that works: the same
// suffixes vitest's own `include` uses. A directory rule would be a second,
// drifting definition of "a test", and a substring rule would quietly hand the
// larger budget to any source file with "test" in its name.
import { describe, expect, test } from "vitest";

import {
  SOURCE_BUDGET,
  TEST_BUDGET,
  budgetFor,
} from "../../../scripts/check-file-size.mjs";

describe("check-file-size budgets", () => {
  test("holds application code to the tighter source budget", () => {
    expect(SOURCE_BUDGET).toBe(400);
    expect(budgetFor("src/lib/wine-intelligence/assistant-query.ts")).toBe(SOURCE_BUDGET);
    expect(budgetFor("src/app/(app)/assistant-panel.tsx")).toBe(SOURCE_BUDGET);
  });

  test("gives a vitest suite room for its cases", () => {
    expect(TEST_BUDGET).toBe(1000);
    expect(budgetFor("src/lib/wine-intelligence/assistant-query.test.ts")).toBe(TEST_BUDGET);
    expect(budgetFor("src/app/(app)/assistant-panel.test.tsx")).toBe(TEST_BUDGET);
  });

  // src/test/ holds helpers and fixtures as well as suites. A helper is
  // ordinary code that happens to serve tests, so it keeps the source budget —
  // otherwise the gate's loosest limit would cover a whole directory tree.
  test("does not treat test-support code as a suite", () => {
    expect(budgetFor("src/test/live-db-target.ts")).toBe(SOURCE_BUDGET);
    expect(budgetFor("src/test/fixtures/wine-corpus-double.ts")).toBe(SOURCE_BUDGET);
  });

  // The guard against a naive substring match: these are application modules.
  test("does not treat a source file merely named after testing as a suite", () => {
    expect(budgetFor("src/lib/latest-scan.ts")).toBe(SOURCE_BUDGET);
    expect(budgetFor("src/lib/contest.ts")).toBe(SOURCE_BUDGET);
  });
});
