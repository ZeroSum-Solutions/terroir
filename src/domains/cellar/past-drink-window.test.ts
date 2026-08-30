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
type InvRow = { wine_id: string; quantity: number; bin_location: string | null };

function makeSupabase(opts: {
  wines?: WineRow[];
  wineErr?: { message: string } | null;
  invRows?: InvRow[];
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
              data: opts.invRows ?? [],
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
});
