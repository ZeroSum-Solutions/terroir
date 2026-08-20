import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { YieldReportSection } from "./yield-report-section";

describe("YieldReportSection", () => {
  it("EV-10.3: links every per-bottle actual and theoretical yield figure to its wine drawer", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <YieldReportSection
        groups={[
          {
            preservationMethod: "coravin",
            bottlesClosed: 1,
            averageVarianceMl: -12,
            actualPouredMl: 562,
            theoreticalPouredMl: 550,
            bottles: [
              {
                bottleId: "b-1",
                wineId: "wine/a",
                preservationMethod: "coravin",
                varianceMl: -12,
                actualPouredMl: 562,
                theoreticalPouredMl: 550,
              },
            ],
          },
        ]}
      />,
    );

    const metrics = [...document.querySelectorAll<HTMLElement>("[data-metric]")];
    expect(metrics).toHaveLength(6);
    expect(metrics.slice(0, 4).map((metric) => metric.querySelector("a")?.getAttribute("href"))).toEqual([
      "/cellar",
      "/cellar",
      "/cellar",
      "/cellar",
    ]);
    expect(metrics.slice(4).map((metric) => metric.querySelector("a")?.getAttribute("href"))).toEqual([
      "/cellar?wine=wine%2Fa",
      "/cellar?wine=wine%2Fa",
    ]);
    expect(document.body.textContent).toContain("Coravin");
    expect(document.body.textContent).toContain("562 ml actual");
    expect(document.body.textContent).toContain("550 ml theoretical");
  });
});
