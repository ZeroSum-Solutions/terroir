import { describe, expect, it } from "vitest";
import { fetchPastDrinkWindow } from "./past-drink-window";

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";

type WineRow = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  drink_window_end: number | null;
};
type InvRow = { wine_id: string | null; quantity: number | null; bin_location: string | null };

function makeSupabase(opts: {
  wines?: WineRow[];
  wineErr?: { message: string } | null;
  invRows?: InvRow[] | null;
  invErr?: { message: string } | null;
}) {
  const from = (table: string) => {
    if (table === "wines") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              not: () => ({
                lt: async () => ({
                  data: opts.wines ?? [],
                  error: opts.wineErr ?? null,
                }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === "inventory_items") {
      return {
        select: () => ({
          eq: () => ({
            in: async () => ({
              data: opts.invRows === undefined ? [] : opts.invRows,
              error: opts.invErr ?? null,
            }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  return { from } as never;
}

describe("fetchPastDrinkWindow", () => {
  it("returns an empty array when no wines are past their window", async () => {
    const supabase = makeSupabase({ wines: [] });
    await expect(fetchPastDrinkWindow(supabase, RESTAURANT_ID)).resolves.toEqual([]);
  });

  it("throws on a wines query error", async () => {
    const supabase = makeSupabase({ wineErr: { message: "boom" } });
    await expect(fetchPastDrinkWindow(supabase, RESTAURANT_ID)).rejects.toEqual({
      message: "boom",
    });
  });

  it("throws on an inventory query error", async () => {
    const supabase = makeSupabase({
      wines: [
        { id: "w1", name: "Wine A", producer: "Producer A", vintage: 2010, drink_window_end: 2018 },
      ],
      invErr: { message: "inv boom" },
    });
    await expect(fetchPastDrinkWindow(supabase, RESTAURANT_ID)).rejects.toEqual({
      message: "inv boom",
    });
  });

  it("drops wines with no stock on hand", async () => {
    const supabase = makeSupabase({
      wines: [
        { id: "w1", name: "Wine A", producer: "Producer A", vintage: 2010, drink_window_end: 2018 },
      ],
      invRows: [{ wine_id: "w1", quantity: 0, bin_location: null }],
    });
    await expect(fetchPastDrinkWindow(supabase, RESTAURANT_ID)).resolves.toEqual([]);
  });

  it("aggregates inventory quantity per wine and sorts oldest-past-peak first", async () => {
    const supabase = makeSupabase({
      wines: [
        { id: "w1", name: "Wine A", producer: "Zeta", vintage: 2010, drink_window_end: 2020 },
        { id: "w2", name: "Wine B", producer: "Alpha", vintage: 2005, drink_window_end: 2015 },
      ],
      invRows: [
        { wine_id: "w1", quantity: 2, bin_location: "A1" },
        { wine_id: "w2", quantity: 1, bin_location: null },
        { wine_id: "w2", quantity: 3, bin_location: "B2" },
      ],
    });

    const rows = await fetchPastDrinkWindow(supabase, RESTAURANT_ID);

    expect(rows).toEqual([
      {
        wine_id: "w2",
        name: "Wine B",
        producer: "Alpha",
        vintage: 2005,
        drink_window_end: 2015,
        bottle_count: 4,
        bin_location: "B2",
      },
      {
        wine_id: "w1",
        name: "Wine A",
        producer: "Zeta",
        vintage: 2010,
        drink_window_end: 2020,
        bottle_count: 2,
        bin_location: "A1",
      },
    ]);
  });

  it("breaks a drink_window_end tie on producer name", async () => {
    // Covers the comparator's second branch: with equal window ends the
    // sort falls through to localeCompare, which the oldest-first case
    // above never reaches.
    const supabase = makeSupabase({
      wines: [
        { id: "zeta", name: "Wine A", producer: "Zeta", vintage: 2010, drink_window_end: 2015 },
        { id: "alpha", name: "Wine B", producer: "Alpha", vintage: 2011, drink_window_end: 2015 },
      ],
      invRows: [
        { wine_id: "zeta", quantity: 1, bin_location: "A1" },
        { wine_id: "alpha", quantity: 1, bin_location: "B1" },
      ],
    });

    const rows = await fetchPastDrinkWindow(supabase, RESTAURANT_ID);
    expect(rows.map((r) => r.wine_id)).toEqual(["alpha", "zeta"]);
  });

  it("sorts a null drink_window_end last rather than first", async () => {
    // Covers the `?? 9999` fallback on both sides of the comparison. A
    // null window is unknown, not urgent, so it must not lead a list whose
    // whole purpose is 'these are past their peak'.
    const supabase = makeSupabase({
      wines: [
        { id: "unknown", name: "Wine A", producer: "Alpha", vintage: 2010, drink_window_end: null },
        { id: "known", name: "Wine B", producer: "Zeta", vintage: 2011, drink_window_end: 2015 },
      ],
      invRows: [
        { wine_id: "unknown", quantity: 1, bin_location: "A1" },
        { wine_id: "known", quantity: 1, bin_location: "B1" },
      ],
    });

    const rows = await fetchPastDrinkWindow(supabase, RESTAURANT_ID);
    expect(rows.map((r) => r.wine_id)).toEqual(["known", "unknown"]);
  });

  it("tolerates a null inventory payload without throwing", async () => {
    // Supabase returns data: null alongside error: null on some paths. The
    // `invRows ?? []` guard is the only thing standing between that and a
    // TypeError iterating null.
    const supabase = makeSupabase({
      wines: [
        { id: "w1", name: "Wine A", producer: "Alpha", vintage: 2010, drink_window_end: 2015 },
      ],
      invRows: null,
    });

    await expect(fetchPastDrinkWindow(supabase, RESTAURANT_ID)).resolves.toEqual([]);
  });

  it("skips inventory rows with no wine_id and counts a null quantity as zero", async () => {
    // Both are defensive branches against the column types, which are
    // nullable even though the happy path never produces them. An orphan
    // row must not create a phantom entry, and a null quantity must not
    // turn the running total into NaN.
    const supabase = makeSupabase({
      wines: [
        { id: "w1", name: "Wine A", producer: "Alpha", vintage: 2010, drink_window_end: 2015 },
      ],
      invRows: [
        { wine_id: null, quantity: 5, bin_location: "GHOST" },
        { wine_id: "w1", quantity: null, bin_location: null },
        { wine_id: "w1", quantity: 2, bin_location: "A1" },
      ],
    });

    const rows = await fetchPastDrinkWindow(supabase, RESTAURANT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].bottle_count).toBe(2);
    expect(rows[0].bin_location).toBe("A1");
  });
});
