import { describe, expect, it, vi } from "vitest";
import { STALLED_AFTER_MS, STALLED_REASON, expireStalledScans } from "./stalled-scans";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

/**
 * POST /api/scan creates the ledger row as "processing" before extraction
 * and updates it after. If the process dies in between (a deploy, a crash,
 * a killed request) the row stays "processing" forever — production's demo
 * tenant had one exactly like that, spinning since the day it was created.
 * The scans page now settles such rows honestly before it lists them.
 */
function stubSupabase(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[]> = { update: [], eq: [], lt: [], select: [] };
  const node: Record<string, unknown> = {};
  for (const m of ["eq", "lt", "select"]) node[m] = vi.fn((...a: unknown[]) => { calls[m].push(a); return node; });
  node.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve(result).then(res, rej);
  const supabase = { from: vi.fn(() => ({ update: vi.fn((p: unknown) => { calls.update.push([p]); return node; }) })) };
  return { supabase, calls };
}

describe("expireStalledScans", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");

  it("marks only this tenant's processing rows older than the cutoff as failed/stalled, and reports how many", async () => {
    const { supabase, calls } = stubSupabase({ data: [{ id: "a" }, { id: "b" }], error: null });
    const n = await expireStalledScans({ supabase: supabase as never, restaurantId: "r1", now });
    expect(n).toBe(2);
    expect(supabase.from).toHaveBeenCalledWith("invoice_scans");
    expect(calls.update[0]).toEqual([{ status: "failed", status_reason: STALLED_REASON }]);
    expect(calls.eq).toEqual([["restaurant_id", "r1"], ["status", "processing"]]);
    expect(calls.lt).toEqual([["created_at", new Date(now.getTime() - STALLED_AFTER_MS).toISOString()]]);
  });

  it("a database error never blocks the page: reports zero and moves on", async () => {
    const { supabase } = stubSupabase({ data: null, error: { message: "boom" } });
    await expect(expireStalledScans({ supabase: supabase as never, restaurantId: "r1", now })).resolves.toBe(0);
  });

  it("the cutoff is fifteen minutes: no legitimate synchronous scan lives that long", () => {
    expect(STALLED_AFTER_MS).toBe(15 * 60 * 1000);
  });
});
