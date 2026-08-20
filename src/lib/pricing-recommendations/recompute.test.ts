import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { runPricingRecommendationsRecompute } from "./recompute";

const NOW = new Date("2026-08-19T12:00:00.000Z");

describe("runPricingRecommendationsRecompute", () => {
  it("builds complete recommendations from paginated table inputs and removes stale rows", async () => {
    const fixture = makeClient();

    const result = await runPricingRecommendationsRecompute(
      fixture.client,
      "restaurant-1",
      "user-1",
      NOW,
    );

    expect(result).toEqual({
      recommended: 1,
      classes: {
        discount_to_move: 0,
        raise_appreciating: 0,
        feature_btg: 1,
        hold: 0,
      },
    });
    expect(fixture.recommendationRows).toEqual([
      expect.objectContaining({
        restaurant_id: "restaurant-1",
        wine_id: "wine-1",
        class: "feature_btg",
        rationale: expect.any(String),
        evidence: expect.objectContaining({ selectedDay: "Tuesday" }),
        timing: "Feature BTG Tuesday",
      }),
    ]);
    expect(fixture.deletedRecommendationIds).toEqual(["wine-stale"]);
    expect(fixture.jobInserts[0]).toMatchObject({
      job_type: "pricing_recommendations",
      status: "processing",
    });
    expect(fixture.jobUpdates.at(-1)).toMatchObject({ status: "succeeded" });
    expect(fixture.ranges.length).toBeGreaterThan(0);
  });

  it("records a redacted failed background job when input loading fails", async () => {
    const fixture = makeClient({ wineError: new Error("sensitive database detail") });

    await expect(
      runPricingRecommendationsRecompute(
        fixture.client,
        "restaurant-1",
        "user-1",
        NOW,
      ),
    ).rejects.toThrow("sensitive database detail");
    expect(fixture.jobUpdates.at(-1)).toMatchObject({
      status: "failed",
      error_code: "pricing_recommendations_recompute_failed",
      error_message: "Pricing recommendations recompute failed.",
    });
  });

  it("treats a zero cost basis as missing margin instead of a 100% margin", async () => {
    const fixture = makeClient({ unitCost: 0 });

    await runPricingRecommendationsRecompute(
      fixture.client,
      "restaurant-1",
      "user-1",
      NOW,
    );

    expect(fixture.recommendationRows).toEqual([
      expect.objectContaining({
        class: "hold",
        evidence: expect.objectContaining({ marginPct: null }),
      }),
    ]);
  });

  it("ignores list pricing embedded from another restaurant", async () => {
    const fixture = makeClient({ listRestaurantId: "restaurant-other" });

    await runPricingRecommendationsRecompute(
      fixture.client,
      "restaurant-1",
      "user-1",
      NOW,
    );

    expect(fixture.recommendationRows).toEqual([
      expect.objectContaining({
        class: "hold",
        evidence: expect.objectContaining({ marginPct: null }),
      }),
    ]);
  });
});

function makeClient(
  options: {
    wineError?: Error;
    unitCost?: number;
    listRestaurantId?: string;
  } = {},
) {
  const fixture = {
    recommendationRows: [] as Array<Record<string, unknown>>,
    deletedRecommendationIds: [] as string[],
    jobInserts: [] as Array<Record<string, unknown>>,
    jobUpdates: [] as Array<Record<string, unknown>>,
    ranges: [] as Array<[number, number]>,
  };
  const results: Record<string, { data: unknown[]; error: unknown }> = {
    wines: {
      data: [{ id: "wine-1", retail_median: 21, size_ml: 750 }],
      error: options.wineError ?? null,
    },
    inventory_items: {
      data: [{
        id: "inv-1",
        wine_id: "wine-1",
        quantity: 6,
        unit_cost: options.unitCost ?? 20,
      }],
      error: null,
    },
    cellar_health: {
      data: [{ wine_id: "wine-1", segment: "healthy" }],
      error: null,
    },
    pour_events: {
      data: [
        { id: "pour-1", wine_id: "wine-1", kind: "pour", ml_delta: 148, occurred_at: "2026-08-18T12:00:00.000Z" },
        { id: "pour-2", wine_id: "wine-1", kind: "pour", ml_delta: 148, occurred_at: "2026-08-15T12:00:00.000Z" },
        { id: "pour-3", wine_id: "wine-1", kind: "pour", ml_delta: 148, occurred_at: "2026-08-15T13:00:00.000Z" },
      ],
      error: null,
    },
    wine_list_items: {
      data: [{
        id: "item-1",
        wine_id: "wine-1",
        bottle_price: 90,
        glass_price: 25,
        glass_pour_ml: 148,
        wine_list_sections: {
          wine_lists: {
            restaurant_id: options.listRestaurantId ?? "restaurant-1",
          },
        },
      }],
      error: null,
    },
    pricing_recommendations: {
      data: [{ wine_id: "wine-1" }, { wine_id: "wine-stale" }],
      error: null,
    },
  };

  const from = (table: string) => {
    if (table === "background_jobs") {
      return {
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              fixture.jobInserts.push(row);
              return { data: { id: "job-1" }, error: null };
            },
          }),
        }),
        update: (row: Record<string, unknown>) => ({
          eq: async () => {
            fixture.jobUpdates.push(row);
            return { error: null };
          },
        }),
      };
    }
    const result = results[table] ?? { data: [], error: null };
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      order: () => chain,
      range: (from: number, to: number) => {
        fixture.ranges.push([from, to]);
        return chain;
      },
      limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (
        resolve: (value: typeof result) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    if (table !== "pricing_recommendations") return chain;
    return {
      ...chain,
      upsert: async (rows: Array<Record<string, unknown>>) => {
        fixture.recommendationRows.push(...rows);
        return { error: null };
      },
      delete: () => ({
        eq: () => ({
          in: async (_column: string, ids: string[]) => {
            fixture.deletedRecommendationIds.push(...ids);
            return { error: null };
          },
        }),
      }),
    };
  };

  return {
    ...fixture,
    client: { from } as unknown as SupabaseClient<Database>,
  };
}
