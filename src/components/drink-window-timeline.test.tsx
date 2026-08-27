import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DrinkWindowTimeline } from "./drink-window-timeline";

describe("DrinkWindowTimeline", () => {
  it.each([
    { currentYear: 1999, transform: "translateX(0)" },
    { currentYear: 2005, transform: "translateX(-50%)" },
    { currentYear: 2026, transform: "translateX(-100%)" },
  ])(
    "keeps the $currentYear marker label inside the timeline",
    ({ currentYear, transform }) => {
      document.body.innerHTML = renderToStaticMarkup(
        <DrinkWindowTimeline
          start={2000}
          end={2010}
          currentYear={currentYear}
        />,
      );

      const label = [...document.querySelectorAll<HTMLElement>("div")].find(
        (element) => element.textContent === `Today · ${currentYear}`,
      );
      expect(label?.style.transform).toBe(transform);
    },
  );

  it("places the today marker past the track end when the window is over", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <DrinkWindowTimeline start={2000} end={2010} currentYear={2026} />,
    );

    const marker = document.querySelector<HTMLElement>(
      "[data-past-window='true']",
    );
    expect(marker).not.toBeNull();
    expect(marker?.style.left).toBe("calc(100% + 10px)");
  });

  it("keeps the today marker on the track while the window is open", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <DrinkWindowTimeline start={2000} end={2010} currentYear={2005} />,
    );

    expect(document.querySelector("[data-past-window='true']")).toBeNull();
  });

  it("labels the peak year on the axis instead of the bare midpoint", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <DrinkWindowTimeline
        start={2013}
        end={2023}
        peak={2017}
        currentYear={2020}
      />,
    );

    expect(document.body.textContent).toContain("Peak 2017");
    // 2018 is the rounded midpoint — it must not render as a second,
    // conflicting tick next to the true peak.
    expect(document.body.textContent).not.toContain("2018");
  });

  it("falls back to the midpoint year when no peak is known", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <DrinkWindowTimeline start={2000} end={2010} currentYear={2004} />,
    );

    expect(document.body.textContent).toContain("2005");
  });
});
