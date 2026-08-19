import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PourAnalyticsContent } from "./pour-analytics-section";

describe("PourAnalyticsContent", () => {
  it("deep-links every ranked wine metric to that wine", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PourAnalyticsContent
        data={{
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
        }}
      />,
    );

    const ranked = [...document.querySelectorAll<HTMLElement>('[data-metric^="ranked-"]')];
    expect(ranked).toHaveLength(2);
    expect(ranked.map((row) => row.querySelector("a")?.getAttribute("href"))).toEqual([
      "/cellar?wine=wine-pours",
      "/cellar?wine=wine-revenue",
    ]);
  });
});
