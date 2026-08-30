import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThroughputBarChart } from "./throughput-bar-chart";

describe("ThroughputBarChart", () => {
  it("renders nothing for empty data", () => {
    expect(renderToStaticMarkup(<ThroughputBarChart data={[]} />)).toBe("");
  });

  it("renders one bar per week, scaled to the max count", () => {
    const markup = renderToStaticMarkup(
      <ThroughputBarChart
        data={[
          { weekLabel: "Jan 5", count: 2 },
          { weekLabel: "Jan 12", count: 4 },
        ]}
      />,
    );
    document.body.innerHTML = markup;

    const bars = document.querySelectorAll(".bg-accent\\/70");
    expect(bars).toHaveLength(2);
    // Full-height bar (count === max) hits the 120px cap.
    expect((bars[1] as HTMLElement).style.height).toBe("120px");
    // Half-height bar is scaled proportionally.
    expect((bars[0] as HTMLElement).style.height).toBe("60px");
  });

  it("floors bar height at 2px so a zero-count week still renders a sliver", () => {
    const markup = renderToStaticMarkup(
      <ThroughputBarChart
        data={[
          { weekLabel: "Jan 5", count: 0 },
          { weekLabel: "Jan 12", count: 10 },
        ]}
      />,
    );
    document.body.innerHTML = markup;
    const bars = document.querySelectorAll(".bg-accent\\/70");
    expect((bars[0] as HTMLElement).style.height).toBe("2px");
  });

  it("labels every bar when there are 8 or fewer weeks", () => {
    const markup = renderToStaticMarkup(
      <ThroughputBarChart
        data={[
          { weekLabel: "Jan 5", count: 1 },
          { weekLabel: "Jan 12", count: 2 },
          { weekLabel: "Jan 19", count: 3 },
        ]}
      />,
    );
    document.body.innerHTML = markup;
    const labels = [...document.querySelectorAll("span")].map((s) => s.textContent);
    expect(labels).toEqual(["Jan 5", "Jan 12", "Jan 19"]);
  });
});
