import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: mockCaptureException }));

const {
  PourAlreadyClosedError,
  PourForbiddenError,
  PourNoInventoryError,
  PourNotFoundError,
  PourRpcError,
  closeOpenBottle,
  recordPour,
  undoLastPour,
} = await import("./pour-service");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const WINE_ID = "55555555-5555-4555-8555-555555555555";
const BOTTLE_ID = "66666666-6666-4666-8666-666666666666";

function makeRpcSupabase(rpcResult: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  const from = vi.fn(() => {
    const thenable = {
      select: () => thenable,
      eq: () => thenable,
      is: () => thenable,
      gte: () => thenable,
      in: () => thenable,
      then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    };
    return thenable;
  });
  return { rpc, from };
}

describe("recordPour", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the pour result on success", async () => {
    const supabase = makeRpcSupabase({ data: { wine_id: WINE_ID, remaining_ml: 600 }, error: null });

    const result = await recordPour({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      ml: 150,
      kind: "pour",
    });

    expect(result).toEqual({ wine_id: WINE_ID, remaining_ml: 600 });
    expect(mockRevalidate).toHaveBeenCalledWith("/availability");
  });

  it("maps the TERROIR_OUT_OF_STOCK sentinel to PourNoInventoryError", async () => {
    const supabase = makeRpcSupabase({
      data: null,
      error: { code: "P0001", message: "TERROIR_OUT_OF_STOCK: nothing left" },
    });

    await expect(
      recordPour({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID, ml: 150, kind: "pour" }),
    ).rejects.toBeInstanceOf(PourNoInventoryError);
  });

  it("does not treat every P0001 as out-of-stock — only the TERROIR_OUT_OF_STOCK sentinel", async () => {
    const supabase = makeRpcSupabase({
      data: null,
      error: { code: "P0001", message: "some other raised exception" },
    });

    let error: unknown;
    try {
      await recordPour({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID, ml: 150, kind: "pour" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PourRpcError);
    expect(error).not.toBeInstanceOf(PourNoInventoryError);
  });

  it("maps a 42501 RPC error to PourForbiddenError without reporting to Sentry", async () => {
    const supabase = makeRpcSupabase({ data: null, error: { code: "42501" } });

    await expect(
      recordPour({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID, ml: 150, kind: "pour" }),
    ).rejects.toBeInstanceOf(PourForbiddenError);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("wraps any other RPC error as a reported PourRpcError and does not revalidate", async () => {
    const supabase = makeRpcSupabase({ data: null, error: { code: "XX000", message: "db exploded" } });

    await expect(
      recordPour({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID, ml: 150, kind: "pour" }),
    ).rejects.toBeInstanceOf(PourRpcError);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

describe("undoLastPour", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the RPC result on success", async () => {
    const supabase = makeRpcSupabase({ data: { wine_id: WINE_ID }, error: null });

    const result = await undoLastPour({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID });

    expect(result).toEqual({ wine_id: WINE_ID });
  });

  it("maps the 'no recent pour to undo' message to PourNotFoundError", async () => {
    const supabase = makeRpcSupabase({ data: null, error: { message: "no recent pour to undo" } });

    await expect(
      undoLastPour({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID }),
    ).rejects.toBeInstanceOf(PourNotFoundError);
  });

  it("maps a 42501 error to PourForbiddenError", async () => {
    const supabase = makeRpcSupabase({ data: null, error: { code: "42501", message: "forbidden" } });

    await expect(
      undoLastPour({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID }),
    ).rejects.toBeInstanceOf(PourForbiddenError);
  });

  it("wraps any other error as a reported PourRpcError, not a false not_found", async () => {
    const supabase = makeRpcSupabase({ data: null, error: { message: "db exploded" } });

    let error: unknown;
    try {
      await undoLastPour({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PourRpcError);
    expect(error).not.toBeInstanceOf(PourNotFoundError);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

function makeCloseSupabase(opts: {
  bottle: { id: string; wine_id: string; remaining_ml: number; closed_at: string | null; restaurant_id: string } | null;
  fetchError?: { code?: string } | null;
  rpcError?: { message?: string } | null;
}) {
  const rpc = vi.fn(() => Promise.resolve({ data: null, error: opts.rpcError ?? null }));
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: opts.bottle, error: opts.fetchError ?? null }),
      }),
    }),
  }));
  return { rpc, from };
}

describe("closeOpenBottle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes the bottle via record_pour and returns the closeout", async () => {
    const supabase = makeCloseSupabase({
      bottle: { id: BOTTLE_ID, wine_id: WINE_ID, remaining_ml: 125, closed_at: null, restaurant_id: RESTAURANT_ID },
    });

    const result = await closeOpenBottle({ supabase: supabase as never, restaurantId: RESTAURANT_ID, bottleId: BOTTLE_ID });

    expect(result).toMatchObject({ id: BOTTLE_ID, wine_id: WINE_ID });
    expect(supabase.rpc).toHaveBeenCalledWith("record_pour", {
      p_wine_id: WINE_ID,
      p_ml: 125,
      p_kind: "spill",
      p_note: "Bottle closed (discard remaining)",
    });
    expect(mockRevalidate).toHaveBeenCalledWith("/cellar/open");
  });

  it("treats a PostgREST no-row error the same as a missing bottle (not_found, not a crash)", async () => {
    const supabase = makeCloseSupabase({ bottle: null, fetchError: { code: "PGRST116" } });

    await expect(
      closeOpenBottle({ supabase: supabase as never, restaurantId: RESTAURANT_ID, bottleId: BOTTLE_ID }),
    ).rejects.toBeInstanceOf(PourNotFoundError);
  });

  it("propagates a real fetch error instead of silently treating it as not_found", async () => {
    const supabase = makeCloseSupabase({ bottle: null, fetchError: { code: "XX000" } });

    let error: unknown;
    try {
      await closeOpenBottle({ supabase: supabase as never, restaurantId: RESTAURANT_ID, bottleId: BOTTLE_ID });
    } catch (caught) {
      error = caught;
    }

    expect(error).not.toBeInstanceOf(PourNotFoundError);
    expect((error as { code?: string }).code).toBe("XX000");
  });

  // Authorization: a bottle that exists but belongs to a different
  // restaurant must never be closeable, even though the fetch itself
  // filters only by id (defense-in-depth, not RLS alone).
  it("refuses to close a bottle that belongs to a different restaurant", async () => {
    const supabase = makeCloseSupabase({
      bottle: { id: BOTTLE_ID, wine_id: WINE_ID, remaining_ml: 125, closed_at: null, restaurant_id: "other-restaurant" },
    });

    await expect(
      closeOpenBottle({ supabase: supabase as never, restaurantId: RESTAURANT_ID, bottleId: BOTTLE_ID }),
    ).rejects.toBeInstanceOf(PourForbiddenError);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("refuses to close a bottle that's already closed", async () => {
    const supabase = makeCloseSupabase({
      bottle: {
        id: BOTTLE_ID,
        wine_id: WINE_ID,
        remaining_ml: 125,
        closed_at: "2026-07-03T00:00:00Z",
        restaurant_id: RESTAURANT_ID,
      },
    });

    await expect(
      closeOpenBottle({ supabase: supabase as never, restaurantId: RESTAURANT_ID, bottleId: BOTTLE_ID }),
    ).rejects.toBeInstanceOf(PourAlreadyClosedError);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("wraps a record_pour failure during close as a reported PourRpcError", async () => {
    const supabase = makeCloseSupabase({
      bottle: { id: BOTTLE_ID, wine_id: WINE_ID, remaining_ml: 125, closed_at: null, restaurant_id: RESTAURANT_ID },
      rpcError: { message: "db exploded" },
    });

    await expect(
      closeOpenBottle({ supabase: supabase as never, restaurantId: RESTAURANT_ID, bottleId: BOTTLE_ID }),
    ).rejects.toBeInstanceOf(PourRpcError);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
