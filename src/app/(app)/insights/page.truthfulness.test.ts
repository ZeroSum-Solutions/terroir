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
    expect(source).toMatch(
      /href="\/api\/insights\/csv"[\s\S]*?className="flex min-h-11 /,
    );
    expect(source).toMatch(
      /href=\{metricHref\("varietal", label\)\}[\s\S]*?className="flex min-h-11 /,
    );
    expect(source).toMatch(
      /href="\/scan"[\s\S]*?className="mt-md inline-flex min-h-11 /,
    );
    expect(source).toContain(
      "const visibleDrinkWindowAlerts = drinkWindowAlerts.slice(0, 6)",
    );
    expect(source).toContain("visibleDrinkWindowAlerts.map");
    expect(source).toMatch(
      /href=\{metricHref\("drink-now-count"\)\}[\s\S]*?View all \{drinkWindowAlerts\.length\} in Cellar/,
    );
    expect(source).toContain(
      "const visiblePastDrinkWindowWines = pastDrinkWindowWines.slice(0, 12)",
    );
    expect(source).toContain("visiblePastDrinkWindowWines.map");
    expect(source).toMatch(
      /View all \{pastDrinkWindowWines\.length\} past-window wines in Cellar/,
    );
  });
});
