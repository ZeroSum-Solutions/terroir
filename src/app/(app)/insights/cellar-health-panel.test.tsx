import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CellarHealthPanel } from "./cellar-health-panel";
import { requestCellarHealthRecompute } from "./recompute-cellar-health-button";

describe("CellarHealthPanel", () => {
  it("links every segment count and value figure to its cellar filter", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <CellarHealthPanel
        canRecompute={false}
        summary={[
          { segment: "window_risk", count: 2, value: 400 },
          { segment: "hold", count: 1, value: 300 },
          { segment: "dead_stock", count: 3, value: 200 },
          { segment: "cash_trap", count: 1, value: 600 },
          { segment: "healthy", count: 8, value: 1_200 },
        ]}
      />,
    );

    const figures = [
      ...document.querySelectorAll<HTMLElement>('[data-metric^="cellar-health-"]'),
    ];
    expect(figures).toHaveLength(10);
    for (const figure of figures) {
      const anchor = figure.querySelector<HTMLAnchorElement>("a[href]");
      expect(anchor, figure.dataset.metric).not.toBeNull();
      expect(anchor?.getAttribute("href"), figure.dataset.metric).toMatch(
        /^\/cellar\?health=(window_risk|hold|dead_stock|cash_trap|healthy)$/,
      );
    }
  });
});

describe("requestCellarHealthRecompute", () => {
  it("posts to the recompute runner", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ classified: 4 }), { status: 200 });
    };

    await requestCellarHealthRecompute(request);

    expect(calls).toEqual([
      ["/api/cellar-health/recompute", { method: "POST" }],
    ]);
  });

  it("surfaces a failed recompute", async () => {
    const request = async () => new Response(null, { status: 500 });

    await expect(requestCellarHealthRecompute(request)).rejects.toThrow(
      "Cellar health recompute failed",
    );
  });
});
