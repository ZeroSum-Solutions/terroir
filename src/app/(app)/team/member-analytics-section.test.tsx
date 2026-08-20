import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemberAnalyticsTable } from "./member-analytics-section";

describe("MemberAnalyticsTable", () => {
  it("EV-7.3/7.4: shows house-relative metrics, links each metric to its row, and uses neutral anomaly copy", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <MemberAnalyticsTable
        data={{
          houseMedianCompRate: 0.05,
          members: [{
            memberId: "member-1",
            userId: "user/1",
            role: "staff",
            pourCount: 10,
            pourMl: 1_500,
            compCount: 3,
            compRate: 3 / 13,
            compRateZScore: 2.1,
            closeoutCount: 2,
            closeoutVarianceMl: -45,
            requiresVarianceInvestigation: true,
          }],
        }}
      />,
    );

    expect(document.body.textContent).toContain("House median 5.0%");
    expect(document.body.textContent).toContain("Variance investigation");
    const metrics = [...document.querySelectorAll<HTMLElement>("[data-metric]")];
    expect(metrics).toHaveLength(4);
    expect(metrics.every((metric) =>
      metric.querySelector("a")?.getAttribute("href") === "/team#member-user%2F1"
    )).toBe(true);
  });
});
