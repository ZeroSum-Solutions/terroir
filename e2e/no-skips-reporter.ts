import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

export default class NoSkippedTestsReporter implements Reporter {
  private readonly skippedTests = new Map<string, string>();

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "skipped") {
      this.skippedTests.set(
        test.id,
        test.titlePath().filter(Boolean).join(" › "),
      );
    } else {
      // A serial suite can report later tests skipped after an earlier
      // attempt fails, then run them on a retry. Count final outcomes only.
      this.skippedTests.delete(test.id);
    }
  }

  async onEnd(_result: FullResult): Promise<{ status: "failed" } | undefined> {
    if (this.skippedTests.size === 0) return undefined;

    console.error(
      `\nRefusing a green E2E gate: ${this.skippedTests.size} test(s) were skipped.`,
    );
    for (const title of this.skippedTests.values()) {
      console.error(`  - ${title}`);
    }
    return { status: "failed" };
  }
}
