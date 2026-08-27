import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BriefingAlertCard } from "./briefing-alert-card";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

describe("BriefingAlertCard", () => {
  beforeEach(() => {
    refresh.mockClear();
  });

  const baseAlert = {
    wine_id: "wine-1",
    name: "Barolo",
    producer: "Giacomo Conterno",
    vintage: 2016,
    drink_window_start: 2024,
    drink_window_end: 2028,
    peak_year: 2026,
    rating: 97,
    rating_source: "vinous",
    review_excerpt: "Layered and precise.",
    bottle_count: 2,
    bin_location: "A-12",
  };

  it("keeps actionable bottle and snooze controls without dead menu actions", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <BriefingAlertCard alert={baseAlert} />,
    );

    expect(document.body.textContent).toContain("View 2 bottles");
    expect(document.body.textContent).toContain("Snooze 30 days");
    expect(document.body.textContent).not.toContain("Add to menu");
    expect(document.body.textContent).not.toContain("Add to staff briefing");

    const actions = [...document.querySelectorAll("a, button")].filter(
      (action) =>
        action.textContent?.includes("View 2 bottles") ||
        action.textContent?.includes("Snooze 30 days"),
    );
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.className).toContain("min-h-11");
    }
  });

  it("leads with the fact — no salutation, no account-derived name", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <BriefingAlertCard alert={baseAlert} />,
    );

    expect(document.body.textContent).not.toContain("Hey ");
    expect(document.body.textContent).toContain(
      "2 bottles of Giacomo Conterno, Barolo 2016",
    );
  });

  it("shows the source when known and hides the line entirely when not", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <BriefingAlertCard alert={baseAlert} />,
    );
    expect(document.body.textContent).toContain("Source: Vinous (Galloni)");

    document.body.innerHTML = renderToStaticMarkup(
      <BriefingAlertCard alert={{ ...baseAlert, rating_source: null, rating: null }} />,
    );
    expect(document.body.textContent).not.toContain("Source:");
    expect(document.body.textContent).not.toContain("Unknown");
  });

  it("writes the remaining-window clause as a sentence, never a ledger fragment", () => {
    const thisYear = new Date().getFullYear();
    document.body.innerHTML = renderToStaticMarkup(
      <BriefingAlertCard
        alert={{ ...baseAlert, drink_window_end: thisYear }}
      />,
    );
    expect(document.body.textContent).toContain("Final year of the optimal window");
    expect(document.body.textContent).not.toContain("~—");
    expect(document.body.textContent).not.toContain("remaining of optimal");

    document.body.innerHTML = renderToStaticMarkup(
      <BriefingAlertCard
        alert={{ ...baseAlert, drink_window_end: null }}
      />,
    );
    expect(document.body.textContent).not.toContain("remaining");
  });
});
