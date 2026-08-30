import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sparkline } from "./sparkline";

describe("Sparkline", () => {
  it("renders nothing when fewer than two points are given", () => {
    expect(renderToStaticMarkup(<Sparkline data={[{ value: 1 }]} />)).toBe("");
    expect(renderToStaticMarkup(<Sparkline data={[]} />)).toBe("");
  });

  it("renders an svg with one point per data value plus an accessible label", () => {
    const markup = renderToStaticMarkup(
      <Sparkline
        data={[
          { value: 2, date: "2026-01-01T12:00:00.000Z" },
          { value: 5, date: "2026-01-02T12:00:00.000Z" },
          { value: 3, date: "2026-01-03T12:00:00.000Z" },
        ]}
      />,
    );
    document.body.innerHTML = markup;

    const svg = document.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-label")).toBe(
      "Scan activity over the last 3 scans: 2–5 items per scan, most recent 3.",
    );
    // One visible point circle + one transparent hit-target circle per point.
    expect(document.querySelectorAll("circle").length).toBe(6);
    // Tooltip title text on the last point includes the item count and a
    // formatted date (exact date text is timezone-dependent, so match loosely).
    const titles = [...document.querySelectorAll("title")].map((t) => t.textContent);
    expect(titles.some((t) => /^3 items · \w+ \d+/.test(t ?? ""))).toBe(true);
  });

  it("places the last point's marker at the end of the path", () => {
    const markup = renderToStaticMarkup(
      <Sparkline data={[{ value: 1 }, { value: 1 }]} />,
    );
    document.body.innerHTML = markup;
    const visibleCircles = [...document.querySelectorAll("circle")].filter(
      (c) => c.getAttribute("fill") !== "transparent",
    );
    expect(visibleCircles).toHaveLength(2);
    // Last point gets a larger radius (4) than earlier points (2.5).
    expect(visibleCircles[1].getAttribute("r")).toBe("4");
    expect(visibleCircles[0].getAttribute("r")).toBe("2.5");
  });
});
