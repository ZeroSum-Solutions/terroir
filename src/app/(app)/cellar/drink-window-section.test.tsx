import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DrinkWindowSection } from "./drink-window-section";
import { baseRow } from "./test-row";

const NOW_YEAR = new Date().getFullYear();

describe("DrinkWindowSection", () => {
  it("shows the review excerpt with rating citation when present", () => {
    const html = renderToStaticMarkup(
      <DrinkWindowSection
        row={baseRow({
          drink_window_start: NOW_YEAR - 2,
          drink_window_end: NOW_YEAR + 5,
          peak_year: NOW_YEAR,
          review_excerpt: "Bright acidity, long finish.",
          rating: 94,
          rating_source: "Wine Spectator",
        })}
      />,
    );
    expect(html).toContain("Bright acidity, long finish.");
    expect(html).toContain("94 pts");
    expect(html).toContain("Wine Spectator");
  });

  it("omits the citation block when there is no review excerpt", () => {
    const html = renderToStaticMarkup(
      <DrinkWindowSection
        row={baseRow({
          drink_window_start: NOW_YEAR - 2,
          drink_window_end: NOW_YEAR + 5,
        })}
      />,
    );
    expect(html).not.toContain("blockquote");
  });

  it("shows years-past for a window already closed", () => {
    const html = renderToStaticMarkup(
      <DrinkWindowSection
        row={baseRow({
          drink_window_start: NOW_YEAR - 10,
          drink_window_end: NOW_YEAR - 2,
        })}
      />,
    );
    expect(html).toContain("2 years past");
  });
});
