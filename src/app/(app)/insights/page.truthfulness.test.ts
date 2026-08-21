import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Insights page metric scope", () => {
  it("wires truthful snapshot and selected-range labels to their metric owners", () => {
    const source = readFileSync(
      resolve("src/app/(app)/insights/page.tsx"),
      "utf8",
    );

    expect(source).not.toMatch(/\bscanItems\b/);
    expect(source).toMatch(
      /normalizeInsightsRange\(\s*sp\.range,\s*sp\.from,\s*sp\.to,\s*\)/,
    );
    expect(source).toContain("summarizeDistributorMetrics(allScans)");
    expect(source).toContain(
      "distributorSpendShare(metric.spend, distTotalSpend)",
    );
    for (const metric of [
      "inventory",
      "varietal-spend",
      "scan-activity",
      "extraction-accuracy",
      "scan-throughput",
      "top-distributors",
      "recent-activity",
    ]) {
      expect(source).toContain(`metric="${metric}"`);
    }
    expect(source).toMatch(
      /<YieldReportSection\s+groups=\{yieldGroups\}\s+rangeLabel=\{selectedRangeLabel\}\s*\/>/,
    );
  });
});
