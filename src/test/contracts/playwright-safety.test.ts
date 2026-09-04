import { readFileSync } from "node:fs";
import path from "node:path";

import type { FullResult, TestCase, TestResult } from "@playwright/test/reporter";
import { describe, expect, test, vi } from "vitest";

import NoSkippedTestsReporter from "../../../e2e/no-skips-reporter";

const repoRoot = path.resolve(__dirname, "../../..");

describe("Playwright safety contract", () => {
  test("starts its own guarded local server", () => {
    const config = readFileSync(path.join(repoRoot, "playwright.config.ts"), "utf8");

    expect(config).toContain('command: "scripts/local/dev-local.sh"');
    expect(config).toContain("reuseExistingServer: false");
    expect(config).toContain("timeout: process.env.CI ? 60_000 : 30_000");
    expect(config).toContain("retries: 0");
    expect(config).not.toContain('command: "pnpm dev"');
  });

  test("the required CI journey gate rejects skipped tests", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain(
      "FAIL_ON_SKIPPED_TESTS=1 pnpm exec playwright test " +
        "e2e/demo-critical-journeys.test.ts e2e/pour-flow.test.ts",
    );
  });

  test("the reporter preserves a run with no skipped tests", async () => {
    const reporter = new NoSkippedTestsReporter();

    await expect(reporter.onEnd({ status: "passed" } as FullResult)).resolves.toBeUndefined();
  });

  test("the reporter turns a skipped test into a failed run", async () => {
    const reporter = new NoSkippedTestsReporter();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reporter.onTestEnd(
      {
        id: "skipped-id",
        titlePath: () => ["critical journeys", "pour"],
      } as TestCase,
      { status: "skipped" } as TestResult,
    );

    await expect(reporter.onEnd({ status: "passed" } as FullResult)).resolves.toEqual({
      status: "failed",
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("1 test(s) were skipped"));
    expect(error).toHaveBeenCalledWith("  - critical journeys › pour");
  });

  test("the reporter uses the final outcome after an earlier skipped attempt", async () => {
    const reporter = new NoSkippedTestsReporter();
    const testCase = {
      id: "serial-retry-id",
      titlePath: () => ["critical journeys", "invite"],
    } as TestCase;
    reporter.onTestEnd(testCase, { status: "skipped" } as TestResult);
    reporter.onTestEnd(testCase, { status: "passed" } as TestResult);

    await expect(reporter.onEnd({ status: "passed" } as FullResult)).resolves.toBeUndefined();
  });
});
