import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PourAnalyticsContent } from "./pour-analytics-section";

describe("PourAnalyticsContent", () => {
  const data = {
    range: "all",
    topN: 10,
    totalPours: 5,
    pourVolumeBySection: [{ section: "BTG", oz: 25 }],
    topWinesByPours: [
      {
        wine_id: "wine-pours",
        name: "Estate Red",
        producer: "Fixture",
        vintage: 2022,
        pour_count: 5,
      },
    ],
    topWinesByRevenue: [
      {
        wine_id: "wine-revenue",
        name: "Reserve",
        producer: "Fixture",
        vintage: 2021,
        revenue: 95,
        pour_count: 3,
      },
    ],
  };

  it("deep-links every ranked wine metric to that wine", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PourAnalyticsContent data={data} />,
    );

    const ranked = [...document.querySelectorAll<HTMLElement>('[data-metric^="ranked-"]')];
    expect(ranked).toHaveLength(2);
    expect(ranked.map((row) => row.querySelector("a")?.getAttribute("href"))).toEqual([
      "/cellar?wine=wine-pours",
      "/cellar?wine=wine-revenue",
    ]);
    for (const row of ranked) {
      expect(row.querySelector("a")?.className).toContain("min-h-11");
    }
  });

  it("allows every analytics card to shrink within a phone-width grid", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PourAnalyticsContent data={data} />,
    );

    for (const label of ["Volume by section", "Most poured", "Revenue leaders"]) {
      const heading = [...document.querySelectorAll("h3")].find(
        (element) => element.textContent === label,
      );
      expect(heading?.parentElement?.parentElement?.className, label).toContain(
        "min-w-0",
      );
    }

    const revenueRows = document.querySelectorAll(
      '[data-metric^="ranked-revenue-"]',
    );
    expect(revenueRows).not.toHaveLength(0);
    for (const row of revenueRows) {
      expect(row.className).toContain("min-w-0");
    }
  });
});
