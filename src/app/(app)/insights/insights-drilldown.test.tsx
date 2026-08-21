import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OwnerMetricGrid,
  TodayStrip,
  selectTodayExceptions,
  type TodayException,
} from "./insights-drilldown";

const today: TodayException[] = [
  {
    wineId: "wine-closing",
    kind: "drink-window",
    title: "Closing soon",
    detail: "2 bottles · window ends 2027",
  },
  {
    wineId: "wine-pricing",
    kind: "pricing",
    title: "Pricing needs review",
    detail: "Bottle price is off target",
  },
];

function renderFixture(todayExceptions = today) {
  document.body.innerHTML = renderToStaticMarkup(
    <>
      <TodayStrip exceptions={todayExceptions} />
      <OwnerMetricGrid
        metrics={{
          inventoryValue: 12500,
          totalBottles: 418,
          eightysixedCount: 7,
          drinkNowCount: 12,
        }}
      />
    </>,
  );
}

describe("insights drill-down tree", () => {
  it("puts a non-empty real cellar anchor inside every metric element", () => {
    renderFixture();

    const metrics = [...document.querySelectorAll<HTMLElement>("[data-metric]")];
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      const anchor = metric.matches("a[href]")
        ? (metric as HTMLAnchorElement)
        : metric.querySelector<HTMLAnchorElement>("a[href]");
      expect(anchor, metric.dataset.metric).not.toBeNull();
      expect(anchor?.getAttribute("href"), metric.dataset.metric).toMatch(
        /^\/cellar(?:\?|$)/,
      );
    }
  });

  it("renders fewer than three Today items without padding", () => {
    renderFixture(today.slice(0, 1));

    expect(document.querySelectorAll('[data-metric^="today-"]')).toHaveLength(1);
  });

  it("lets every Today item shrink inside the phone-width grid", () => {
    renderFixture();

    const items = document.querySelectorAll<HTMLElement>(
      '[data-metric^="today-"]',
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.className).toContain("min-w-0");
      expect(item.querySelector("a")?.className).toContain("min-w-0");
    }
  });
});

describe("selectTodayExceptions", () => {
  it("keeps priority order, removes duplicate wines, and caps the strip at three", () => {
    const candidates: TodayException[] = [
      ...today,
      { ...today[0], kind: "past-window" },
      {
        wineId: "wine-third",
        kind: "past-window",
        title: "Past window",
        detail: "1 bottle",
      },
      {
        wineId: "wine-fourth",
        kind: "pricing",
        title: "Fourth",
        detail: "Review",
      },
    ];

    expect(selectTodayExceptions(candidates).map((item) => item.wineId)).toEqual([
      "wine-closing",
      "wine-pricing",
      "wine-third",
    ]);
  });
});
