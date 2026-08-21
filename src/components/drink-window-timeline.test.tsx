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
});
