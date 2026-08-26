import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  fetchRetailPrices: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireMembership: mocks.requireMembership,
}));

vi.mock("@/lib/wine-intelligence/wine-searcher", () => ({
  fetchRetailPrices: mocks.fetchRetailPrices,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
}));

import { POST } from "./route";

function makeSupabase() {
  let retailRefreshedAt: string | null = null;
  const updates: Array<Record<string, unknown>> = [];

  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      not: vi.fn(() => chain),
      or: vi.fn(() => chain),
      in: vi.fn(() => chain),
      limit: vi.fn(async () => ({
        data: retailRefreshedAt === null
          ? [{ id: "wine-avg", lwin_id: "1010101", retail_refreshed_at: null }]
          : [],
        error: null,
      })),
      order: vi.fn(async () => ({ data: [], error: null })),
      update: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        if (typeof values.retail_refreshed_at === "string") {
          retailRefreshedAt = values.retail_refreshed_at;
        }
        return chain;
      }),
    };

    if (table !== "wines" && table !== "inventory_items") {
      throw new Error(`Unexpected table: ${table}`);
    }
    return chain;
  });

  return { from, updates };
}

describe("POST /api/wines/refresh-retail-batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WINE_SEARCHER_API_KEY", "configured");
  });

  it("does not re-select an average-only wine on a consecutive batch run", async () => {
    const supabase = makeSupabase();
    mocks.requireMembership.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-1",
      role: "owner",
    });
    mocks.fetchRetailPrices.mockResolvedValue({
      retailMin: 20,
      retailMax: 40,
      retailMedian: 30,
      retailMedianBasis: "average",
      retailerCount: 3,
      refreshedAt: new Date("2026-08-26T12:00:00.000Z"),
    });

    const firstResponse = await POST();
    const secondResponse = await POST();

    expect(await firstResponse.json()).toMatchObject({
      total: 1,
      refreshed: 0,
      skipped: 1,
    });
    expect(supabase.updates).toEqual([
      { retail_refreshed_at: "2026-08-26T12:00:00.000Z" },
    ]);
    expect(await secondResponse.json()).toMatchObject({
      total: 0,
      refreshed: 0,
      skipped: 0,
    });
    expect(mocks.fetchRetailPrices).toHaveBeenCalledTimes(1);
  });
});
