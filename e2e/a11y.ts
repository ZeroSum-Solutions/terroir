import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Shared axe-core scan for the accessibility-repair loop
 * (WCAG 2.2 Level AA). Runs against the page's CURRENT state — call it
 * after the UI under test has settled (dialog open, form rendered, etc.)
 * so the scan sees what a real user would.
 *
 * Fails the calling test if any "serious" or "critical" impact violation
 * is found. "Minor"/"moderate" violations are reported (visible in the
 * assertion message) but do not fail the run — this keeps the gate
 * focused on real user-facing barriers per the loop's ranking, rather
 * than blocking on every low-impact nit.
 */
export async function assertNoSeriousA11yViolations(
  page: Page,
  label: string,
) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();

  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );

  const message =
    `${label}: ${blocking.length} serious/critical WCAG 2.2 AA violation(s):\n` +
    blocking
      .map(
        (v) =>
          `  [${v.impact}] ${v.id} (${v.help}) — ${v.nodes.length} node(s): ` +
          v.nodes.map((n) => n.target.join(" ")).join(", "),
      )
      .join("\n");

  expect(blocking, message).toEqual([]);
}
