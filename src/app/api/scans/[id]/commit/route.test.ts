import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => auth.requireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST } = await import("./route");

const SCAN_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const WINE_ID = "33333333-3333-4333-8333-333333333333";

function lineItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "line-1",
    name: "Barolo",
    producer: "Test Producer",
    vintage: 2019,
    varietal: "Nebbiolo",
    region: "Piedmont",
    qty: 2,
    unitCost: 95,
    currency: "EUR",
    format: "1.5L",
    confidence: 0.92,
    ...overrides,
  };
}

function makeSupabase(options: {
  fetch?: { data: unknown; error: unknown };
  wineIds?: unknown;
  batchError?: unknown;
  inventoryError?: unknown;
  lwin?: "reject" | "throw" | "ok";
} = {}) {
  const fetchBuilder = {
    select: vi.fn(() => fetchBuilder),
    eq: vi.fn(() => fetchBuilder),
    single: vi.fn(() =>
      Promise.resolve(
        options.fetch ?? {
          data: { id: SCAN_ID, final_line_items: [lineItem()] },
          error: null,
        },
      ),
    ),
  };
  const insert = vi.fn(() =>
    Promise.resolve({ error: options.inventoryError ?? null }),
  );
  const from = vi.fn((table: string) =>
    table === "invoice_scans" ? fetchBuilder : { insert },
  );
  const rpc = vi.fn((name: string) => {
    if (name === "find_or_create_wines_batch") {
      return Promise.resolve({
        data: options.wineIds === undefined ? [WINE_ID] : options.wineIds,
        error: options.batchError ?? null,
      });
    }
    if (options.lwin === "throw") throw new Error("LWIN sync failure");
    if (options.lwin === "reject") return Promise.reject(new Error("LWIN reject"));
    return Promise.resolve({ data: null, error: null });
  });
  return { supabase: { from, rpc }, insert, rpc };
}

function authorize(supabase: unknown) {
  auth.requireMembership.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: "44444444-4444-4444-8444-444444444444" },
    role: "staff",
  });
}

function call() {
  return POST({} as NextRequest, {
    params: Promise.resolve({ id: SCAN_ID }),
  });
}

describe("POST /api/scans/[id]/commit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects corrupt persisted line items before mutations", async () => {
    const db = makeSupabase({
      fetch: {
        data: { id: SCAN_ID, final_line_items: [lineItem({ qty: 1.5 })] },
        error: null,
      },
    });
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("distinguishes missing scans from provider failures", async () => {
    const missing = makeSupabase({
      fetch: { data: null, error: { code: "PGRST116", message: "no rows" } },
    });
    authorize(missing.supabase);
    expect((await call()).status).toBe(404);

    const failed = makeSupabase({
      fetch: {
        data: null,
        error: { code: "XX000", message: "private database detail" },
      },
    });
    authorize(failed.supabase);
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });

  it.each([
    ["a cardinality mismatch", []],
    ["a non-UUID wine ID", ["not-a-uuid"]],
  ])("rejects %s from the wine RPC before inventory insert", async (_name, wineIds) => {
    const db = makeSupabase({ wineIds });
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(500);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"] as const)(
    "keeps successful inventory writes successful when LWIN enrichment %ss",
    async (lwin) => {
      const db = makeSupabase({ lwin });
      authorize(db.supabase);

      const response = await call();

      expect(response.status).toBe(200);
      expect(db.insert).toHaveBeenCalledWith([
        {
          wine_id: WINE_ID,
          restaurant_id: RESTAURANT_ID,
          invoice_scan_id: SCAN_ID,
          quantity: 2,
          unit_cost: 95,
          format: "1.5L",
          currency: "EUR",
          added_via: "invoice_scan",
        },
      ]);
    },
  );

  it("redacts inventory insert failures", async () => {
    const db = makeSupabase({
      inventoryError: { message: "sensitive inventory detail" },
    });
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive");
  });
});
