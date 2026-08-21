import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemberAnalyticsTable } from "./member-analytics-section";

describe("MemberAnalyticsTable", () => {
  it("EV-7.3/7.4: shows house-relative metrics, links each metric to its row, and uses neutral anomaly copy", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <MemberAnalyticsTable
        identities={{}}
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
      metric.querySelector("a")?.getAttribute("href") === "/team#member-czmw3l"
    )).toBe(true);
  });

  it("renders scoped member identities with neutral fallbacks instead of UUID text", () => {
    const resolvedUserId = "11111111-2222-4333-8444-555555555555";
    const fallbackUserId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const resolvedMemberId = "99999999-2222-4333-8444-555555555555";
    const fallbackMemberId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const markup = renderToStaticMarkup(
      <MemberAnalyticsTable
        identities={{
          [resolvedUserId]: {
            name: "Maria Santos",
            email: "maria@example.com",
          },
        }}
        data={{
          houseMedianCompRate: 0,
          members: [
            analyticsMember(resolvedUserId, resolvedMemberId),
            analyticsMember(fallbackUserId, fallbackMemberId),
          ],
        }}
      />,
    );
    document.body.innerHTML = markup;

    expect(document.body.textContent).toContain("Maria Santos");
    expect(document.body.textContent).toContain("maria@example.com");
    expect(document.body.textContent).toContain("Team member");
    expect(document.body.textContent).toContain("Email unavailable");
    expect(document.body.textContent).not.toContain(resolvedUserId);
    expect(document.body.textContent).not.toContain(resolvedUserId.slice(0, 8));
    expect(document.body.textContent).not.toContain(fallbackUserId);
    expect(document.body.textContent).not.toContain(fallbackUserId.slice(0, 8));
    expect(markup).not.toContain(resolvedUserId);
    expect(markup).not.toContain(resolvedUserId.slice(0, 8));
    expect(markup).not.toContain(fallbackUserId);
    expect(markup).not.toContain(fallbackUserId.slice(0, 8));
    expect(markup).not.toContain(resolvedMemberId);
    expect(markup).not.toContain(resolvedMemberId.slice(0, 8));
    expect(markup).not.toContain(fallbackMemberId);
    expect(markup).not.toContain(fallbackMemberId.slice(0, 8));
  });
});

function analyticsMember(userId: string, memberId: string) {
  return {
    memberId,
    userId,
    role: "staff" as const,
    pourCount: 0,
    pourMl: 0,
    compCount: 0,
    compRate: null,
    compRateZScore: null,
    closeoutCount: 0,
    closeoutVarianceMl: 0,
    requiresVarianceInvestigation: false,
  };
}
