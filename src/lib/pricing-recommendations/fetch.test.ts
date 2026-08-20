import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchPricingRecommendations } from "./fetch";

describe("fetchPricingRecommendations", () => {
  it("reads the materialized table with a tenant filter and maps wine details", async () => {
    const result = {
      data: [{
        wine_id: "00000000-0000-4000-8000-000000000001",
        class: "hold",
        rationale: "No action is supported.",
        evidence: {
          healthSegment: "hold",
          appreciation: 0.05,
          appreciationThreshold: 0.08,
          velocity30d: 0,
          marginPct: 60,
          marginThresholdPct: 70,
          dayOfWeekProfile: {},
          selectedDay: null,
        },
        timing: null,
        computed_at: "2026-08-19T12:00:00.000Z",
        wines: { name: "Meursault", producer: "Fixture", vintage: 2020 },
      }],
      error: null,
    };
    const calls: Array<[string, unknown[]]> = [];
    const chain = {
      select: (...args: unknown[]) => {
        calls.push(["select", args]);
        return chain;
      },
      eq: (...args: unknown[]) => {
        calls.push(["eq", args]);
        return chain;
      },
      order: (...args: unknown[]) => {
        calls.push(["order", args]);
        return chain;
      },
      range: (...args: unknown[]) => {
        calls.push(["range", args]);
        return chain;
      },
      then: (
        resolve: (value: typeof result) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const from = vi.fn(() => chain);

    const rows = await fetchPricingRecommendations(
      { from } as unknown as SupabaseClient<Database>,
      "restaurant-1",
    );

    expect(from).toHaveBeenCalledWith("pricing_recommendations");
    expect(calls).toContainEqual(["eq", ["restaurant_id", "restaurant-1"]]);
    expect(rows).toEqual([
      expect.objectContaining({
        class: "hold",
        wineId: "00000000-0000-4000-8000-000000000001",
        wine: { name: "Meursault", producer: "Fixture", vintage: 2020 },
      }),
    ]);
  });

  it("rejects malformed stored evidence instead of hiding the row", async () => {
    const result = {
      data: [{
        wine_id: "00000000-0000-4000-8000-000000000001",
        class: "hold",
        rationale: "No action is supported.",
        evidence: {},
        timing: null,
        computed_at: "2026-08-19T12:00:00.000Z",
        wines: { name: "Meursault", producer: "Fixture", vintage: 2020 },
      }],
      error: null,
    };
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      range: () => chain,
      then: (
        resolve: (value: typeof result) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };

    await expect(
      fetchPricingRecommendations(
        { from: () => chain } as unknown as SupabaseClient<Database>,
        "restaurant-1",
      ),
    ).rejects.toThrow();
  });
});
