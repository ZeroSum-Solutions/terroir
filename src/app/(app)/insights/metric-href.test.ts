import { describe, expect, it } from "vitest";
import { metricHref } from "./metric-href";

describe("metricHref", () => {
  it.each([
    ["inventory-value", "/cellar"],
    ["bottles-in", "/cellar"],
    ["eightysixed-count", "/cellar?filter=out"],
    ["drink-now-count", "/cellar?filter=drink-now"],
  ] as const)("maps %s to its matching cellar view", (metric, expected) => {
    expect(metricHref(metric)).toBe(expected);
  });

  it("deep-links ranked wines to their detail drawer", () => {
    expect(metricHref("wine", "wine-a/b")).toBe(
      "/cellar?wine=wine-a%2Fb",
    );
  });

  it("maps varietal metrics to the exact-match cellar facet", () => {
    expect(metricHref("varietal", "Pinot Noir")).toBe(
      "/cellar?varietal=Pinot%20Noir",
    );
  });
});
