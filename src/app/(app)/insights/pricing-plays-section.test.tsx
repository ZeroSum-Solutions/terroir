import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PricingPlaysSection } from "./pricing-plays-section";
import { requestPricingRecommendationsRecompute } from "./recompute-pricing-recommendations-button";

describe("PricingPlaysSection", () => {
  it("groups every class and renders hold as an explicit no-action row", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PricingPlaysSection
        canRecompute={false}
        recommendations={[
          recommendation("hold", "No pricing move is supported.", null),
          recommendation(
            "feature_btg",
            "Strong margin supports a feature.",
            "Feature BTG Tuesday",
          ),
        ]}
      />,
    );

    expect(document.body.textContent).toContain("Hold — no action");
    expect(document.body.textContent).toContain("No pricing move is supported.");
    expect(document.body.textContent).toContain("Feature BTG Tuesday");
    expect(document.querySelectorAll('[data-pricing-class="hold"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-pricing-class="feature_btg"]')).toHaveLength(1);
    const metrics = [...document.querySelectorAll<HTMLElement>("[data-metric]")];
    expect(metrics).toHaveLength(2);
    for (const metric of metrics) {
      expect(metric.querySelector("a")?.getAttribute("href")).toMatch(
        /^\/cellar\?wine=00000000-0000-4000-8000-/,
      );
    }
  });
});

describe("requestPricingRecommendationsRecompute", () => {
  it("posts to the pricing recompute route", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ recommended: 4 }), { status: 200 });
    };

    await requestPricingRecommendationsRecompute(request);

    expect(calls).toEqual([
      ["/api/pricing-recommendations/recompute", { method: "POST" }],
    ]);
  });

  it("surfaces a failed recompute", async () => {
    const request = async () => new Response(null, { status: 500 });

    await expect(
      requestPricingRecommendationsRecompute(request),
    ).rejects.toThrow("Pricing recommendations recompute failed");
  });
});

function recommendation(
  recommendationClass: "hold" | "feature_btg",
  rationale: string,
  timing: string | null,
) {
  const suffix = recommendationClass === "hold" ? "000000000001" : "000000000002";
  return {
    wineId: `00000000-0000-4000-8000-${suffix}`,
    class: recommendationClass,
    rationale,
    evidence: {
      healthSegment: recommendationClass === "hold" ? "healthy" : "healthy",
      appreciation: null,
      appreciationThreshold: 0.08,
      velocity30d: 4,
      marginPct: recommendationClass === "feature_btg" ? 76 : 55,
      marginThresholdPct: 70,
      dayOfWeekProfile: recommendationClass === "feature_btg" ? { Tuesday: 2 } : {},
      selectedDay: recommendationClass === "feature_btg" ? "Tuesday" : null,
    },
    timing,
    computedAt: "2026-08-19T12:00:00.000Z",
    wine: {
      name: recommendationClass === "hold" ? "Allocated Meursault" : "Gamay",
      producer: "Fixture Producer",
      vintage: 2022,
    },
  } as const;
}
