import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchYieldGroups, YieldReportSection } from "./yield-report-section";

describe("YieldReportSection", () => {
  it("EV-10.3: links every per-bottle actual and theoretical yield figure to its wine drawer", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <YieldReportSection
        groups={[
          {
            preservationMethod: "coravin",
            bottlesClosed: 1,
            averageVarianceMl: -12,
            actualPouredMl: 562,
            theoreticalPouredMl: 550,
            bottles: [
              {
                bottleId: "b-1",
                wineId: "wine/a",
                preservationMethod: "coravin",
                varianceMl: -12,
                actualPouredMl: 562,
                theoreticalPouredMl: 550,
              },
            ],
          },
        ]}
      />,
    );

    const metrics = [...document.querySelectorAll<HTMLElement>("[data-metric]")];
    expect(metrics).toHaveLength(6);
    expect(metrics.slice(0, 4).map((metric) => metric.querySelector("a")?.getAttribute("href"))).toEqual([
      "/cellar",
      "/cellar",
      "/cellar",
      "/cellar",
    ]);
    expect(metrics.slice(4).map((metric) => metric.querySelector("a")?.getAttribute("href"))).toEqual([
      "/cellar?wine=wine%2Fa",
      "/cellar?wine=wine%2Fa",
    ]);
    expect(document.body.textContent).toContain("Coravin");
    expect(document.body.textContent).toContain("562 ml actual");
    expect(document.body.textContent).toContain("550 ml theoretical");
  });

  it("applies the insights date range to closed_at", async () => {
    const calls: Array<[string, unknown]> = [];
    const query = queryReturning([closeoutRow()], calls);
    const supabase = {
      from: () => ({ select: () => query }),
    } as unknown as SupabaseClient<Database>;

    await fetchYieldGroups(
      supabase,
      "restaurant-1",
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-18T23:59:59.999Z"),
    );

    expect(calls).toContainEqual(["gte", ["closed_at", "2026-08-01T00:00:00.000Z"]]);
    expect(calls).toContainEqual(["lte", ["closed_at", "2026-08-18T23:59:59.999Z"]]);
  });

  it("paginates past the former 100-row yield cap", async () => {
    const ranges: Array<[number, number]> = [];
    const firstPage = Array.from({ length: 1_000 }, (_, index) => closeoutRow(`closeout-${index}`));
    const supabase = {
      from: () => ({
        select: () => queryReturning(firstPage, [], ranges),
      }),
    } as unknown as SupabaseClient<Database>;

    const groups = await fetchYieldGroups(supabase, "restaurant-1", null, null);

    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(groups[0]?.bottlesClosed).toBe(1_000);
  });
});

function queryReturning(
  firstPage: ReturnType<typeof closeoutRow>[],
  calls: Array<[string, unknown]>,
  ranges: Array<[number, number]> = [],
) {
  const query = {
    eq: (column: string, value: unknown) => track("eq", [column, value]),
    order: (column: string, options: unknown) => track("order", [column, options]),
    gte: (column: string, value: string) => track("gte", [column, value]),
    lte: (column: string, value: string) => track("lte", [column, value]),
    range: async (from: number, to: number) => {
      ranges.push([from, to]);
      return { data: from === 0 ? firstPage : [], error: null };
    },
  };
  function track(method: string, args: unknown) {
    calls.push([method, args]);
    return query;
  }
  return query;
}

function closeoutRow(id = "closeout-1") {
  return {
    id,
    open_bottle_id: `bottle-${id}`,
    wine_id: "wine-1",
    preservation_method: "coravin",
    theoretical_remaining_ml: 500,
    actual_remaining_ml: 490,
    written_off_ml: 0,
    wines: { size_ml: 750 },
  };
}
