import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { runCellarHealthRecompute } from "./recompute";

const NOW = new Date("2026-08-19T12:00:00.000Z");

describe("runCellarHealthRecompute", () => {
  it("EV-2.4: uses defaults without cellar_config and reclassifies after a threshold change", async () => {
    const fixture = makeClient();

    await runCellarHealthRecompute(fixture.client, "restaurant-1", "user-1", NOW);
    expect(fixture.jobInserts[0]).toMatchObject({ status: "processing" });
    expect(fixture.healthRows.at(-1)).toMatchObject({
      wine_id: "wine-1",
      segment: "healthy",
    });

    fixture.config = {
      health_dead_stock_days: 120,
      health_cash_trap_floor: 500,
      health_appreciation_threshold: 0.2,
    };
    await runCellarHealthRecompute(fixture.client, "restaurant-1", "user-1", NOW);

    expect(fixture.healthRows.at(-1)).toMatchObject({
      wine_id: "wine-1",
      segment: "dead_stock",
      reason: expect.stringMatching(/^dead_stock rule:/),
    });
    expect(fixture.jobUpdates.filter((row) => row.status === "succeeded")).toHaveLength(2);
  });

  it("records a failed background job when input loading fails", async () => {
    const fixture = makeClient({ wineError: new Error("database unavailable") });

    await expect(
      runCellarHealthRecompute(fixture.client, "restaurant-1", "user-1", NOW),
    ).rejects.toThrow("database unavailable");
    expect(fixture.jobUpdates.at(-1)).toMatchObject({
      status: "failed",
      error_code: "cellar_health_recompute_failed",
    });
  });

  it("classifies positive-quantity stock even when its cost basis is zero", async () => {
    const fixture = makeClient({ unitCost: 0 });

    const result = await runCellarHealthRecompute(
      fixture.client,
      "restaurant-1",
      "user-1",
      NOW,
    );

    expect(result.classified).toBe(1);
    expect(fixture.healthRows).toHaveLength(1);
  });

  it("removes prior health rows for wines that are no longer stocked", async () => {
    const fixture = makeClient({ existingHealthWineIds: ["wine-1", "wine-empty"] });

    await runCellarHealthRecompute(fixture.client, "restaurant-1", "user-1", NOW);

    expect(fixture.deletedHealthIds).toEqual(["wine-empty"]);
  });
});

type HealthConfig = {
  health_dead_stock_days: number;
  health_cash_trap_floor: number;
  health_appreciation_threshold: number;
};

function makeClient(
  options: {
    wineError?: Error;
    unitCost?: number;
    existingHealthWineIds?: string[];
  } = {},
) {
  const fixture = {
    config: null as HealthConfig | null,
    healthRows: [] as Array<Record<string, unknown>>,
    deletedHealthIds: [] as string[],
    jobInserts: [] as Array<Record<string, unknown>>,
    jobUpdates: [] as Array<Record<string, unknown>>,
  };

  const queryData: Record<string, { data: unknown; error: unknown }> = {
    wines: {
      data: [
        {
          id: "wine-1",
          drink_window_start: null,
          drink_window_end: null,
          retail_median: 110,
        },
      ],
      error: options.wineError ?? null,
    },
    inventory_items: {
      data: [
        {
          wine_id: "wine-1",
          quantity: 1,
          unit_cost: options.unitCost ?? 100,
          added_at: "2025-01-01T00:00:00.000Z",
        },
      ],
      error: null,
    },
    pour_events: { data: [], error: null },
  };

  const from = (table: string) => {
    if (table === "background_jobs") {
      return {
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              fixture.jobInserts.push(row);
              return { data: { id: `job-${fixture.jobUpdates.length + 1}` }, error: null };
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
    if (table === "cellar_health") {
      const selected = {
        data: (options.existingHealthWineIds ?? []).map((wine_id) => ({ wine_id })),
        error: null,
      };
      const selectChain = {
        select: () => selectChain,
        eq: () => selectChain,
        order: () => selectChain,
        range: () => selectChain,
        then: (
          resolve: (value: typeof selected) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(selected).then(resolve, reject),
      };
      return {
        ...selectChain,
        upsert: async (rows: Array<Record<string, unknown>>) => {
          fixture.healthRows.push(...rows);
          return { error: null };
        },
        delete: () => ({
          eq: () => ({
            in: async (_column: string, ids: string[]) => {
              fixture.deletedHealthIds.push(...ids);
              return { error: null };
            },
          }),
        }),
      };
    }
    if (table === "cellar_config") {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: fixture.config, error: null }),
      };
      return chain;
    }
    const result = queryData[table];
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      range: () => chain,
      then: (
        resolve: (value: { data: unknown; error: unknown }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };

  return {
    ...fixture,
    get config() {
      return fixture.config;
    },
    set config(value: HealthConfig | null) {
      fixture.config = value;
    },
    client: { from } as unknown as SupabaseClient<Database>,
  };
}
