import { describe, expect, it } from "vitest";
import { fetchPricingAlerts } from "./alerts";

/**
 * The defect this file exists for.
 *
 * `fetchPricingAlerts` filtered two tables with `.in("wine_id", wineIds)`
 * carrying EVERY eligible wine. PostgREST puts an `.in()` filter in the URL, so
 * on the 250-wine seed the query string reached 9,262 characters and the server
 * answered **HTTP 414 URI Too Long** — measured against the running stack, not
 * estimated.
 *
 * It was invisible because `insights/page.tsx` calls this behind
 * `.catch(() => [])`: the Pricing Review card simply never mounted, and the
 * larger the restaurant the more certain it was to be missing. A cellar big
 * enough to need pricing review was exactly the one that could not get it.
 *
 * These tests assert the request SHAPE rather than the row output, because the
 * shape is the bug: no single request may carry an unbounded id list.
 */

const CHUNK_LIMIT = 100;

type Call = { table: string; ids: string[] | null };

/**
 * A Supabase stub that records the `.in()` list each query was given.
 *
 * Deliberately not a shared fixture: it exists to observe one thing, and a
 * general-purpose fake would hide the property under test behind its own
 * abstraction.
 */
function recordingClient(wineCount: number) {
  const calls: Call[] = [];
  const wines = Array.from({ length: wineCount }, (_, i) => ({
    id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    name: `Wine ${i}`,
    producer: `Producer ${i}`,
    vintage: 2020,
    varietal: null,
    region: null,
    retail_median: 40,
    size_ml: 750,
    pricing_target_pour_cost_pct: null,
    pricing_target_markup_ratio: null,
    pricing_dismissed_until: null,
  }));

  const builder = (table: string) => {
    const call: Call = { table, ids: null };
    const rows =
      table === "wines" ? wines : table === "restaurants" ? [] : [];
    const api: Record<string, unknown> = {};
    const self = () => api;
    for (const method of ["select", "eq", "not", "or", "order", "limit"]) {
      api[method] = self;
    }
    api.in = (_column: string, ids: string[]) => {
      call.ids = ids;
      calls.push(call);
      return api;
    };
    api.maybeSingle = async () => ({ data: null, error: null });
    api.single = async () => ({ data: null, error: null });
    api.then = (
      resolve: (v: { data: unknown; error: null }) => unknown,
    ) => {
      if (call.ids === null && table !== "wines") calls.push(call);
      return Promise.resolve(resolve({ data: rows, error: null }));
    };
    return api;
  };

  return {
    calls,
    client: { from: (table: string) => builder(table) },
  };
}

describe("fetchPricingAlerts — request shape", () => {
  it("never puts an unbounded wine-id list in one request", async () => {
    const { calls, client } = recordingClient(250);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchPricingAlerts(client as any, "rest-1");

    const withIds = calls.filter((c) => c.ids !== null);
    expect(withIds.length, "expected chunked .in() calls").toBeGreaterThan(0);
    for (const call of withIds) {
      expect(
        call.ids!.length,
        `${call.table} was given ${call.ids!.length} ids in one request; ` +
          "that is the shape that produced HTTP 414 on a 250-wine cellar",
      ).toBeLessThanOrEqual(CHUNK_LIMIT);
    }
  });

  it("still covers every wine across the chunks it sends", async () => {
    const { calls, client } = recordingClient(250);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchPricingAlerts(client as any, "rest-1");

    const byTable = new Map<string, Set<string>>();
    for (const call of calls) {
      if (!call.ids) continue;
      const seen = byTable.get(call.table) ?? new Set<string>();
      for (const id of call.ids) seen.add(id);
      byTable.set(call.table, seen);
    }
    expect(byTable.size, "expected at least one chunked table").toBeGreaterThan(0);
    for (const [table, seen] of byTable) {
      expect(seen.size, `${table} lost wines while chunking`).toBe(250);
    }
  });

  it("sends nothing at all when the cellar has no eligible wines", async () => {
    const { calls, client } = recordingClient(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alerts = await fetchPricingAlerts(client as any, "rest-1");
    expect(alerts).toEqual([]);
    expect(calls.filter((c) => c.ids !== null)).toHaveLength(0);
  });
});
