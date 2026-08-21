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

  it("keeps actionable bottle and snooze controls without dead menu actions", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <BriefingAlertCard
        firstName="Avery"
        alert={{
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
        }}
      />,
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
});
