import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: mockCaptureException }));

const {
  ReconcileExceedsSizeError,
  ReconcileForbiddenError,
  ReconcileRpcError,
  reconcileOpenBottles,
} = await import("./reconcile-service");

function makeSupabase(rpcResult: { data: number | null; error: { code?: string; message?: string } | null }) {
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

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const entries = [{ wine_id: "wine-1", new_remaining_ml: 400 }];

describe("reconcileOpenBottles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the reconciled count on success", async () => {
    const supabase = makeSupabase({ data: 3, error: null });

    const result = await reconcileOpenBottles({ supabase: supabase as never, restaurantId: RESTAURANT_ID, entries });

    expect(result).toBe(3);
    expect(mockRevalidate).toHaveBeenCalledWith("/availability");
  });

  it("maps a 42501 RPC error to ReconcileForbiddenError without reporting to Sentry", async () => {
    const supabase = makeSupabase({ data: null, error: { code: "42501" } });

    await expect(
      reconcileOpenBottles({ supabase: supabase as never, restaurantId: RESTAURANT_ID, entries }),
    ).rejects.toBeInstanceOf(ReconcileForbiddenError);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("maps a P0002 RPC error to ReconcileExceedsSizeError (new_remaining_ml exceeds the bottle size)", async () => {
    const supabase = makeSupabase({ data: null, error: { code: "P0002" } });

    await expect(
      reconcileOpenBottles({ supabase: supabase as never, restaurantId: RESTAURANT_ID, entries }),
    ).rejects.toBeInstanceOf(ReconcileExceedsSizeError);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("wraps any other RPC error as a reported ReconcileRpcError, not a false forbidden/size error", async () => {
    const supabase = makeSupabase({ data: null, error: { code: "XX000", message: "db exploded" } });

    await expect(
      reconcileOpenBottles({ supabase: supabase as never, restaurantId: RESTAURANT_ID, entries }),
    ).rejects.toBeInstanceOf(ReconcileRpcError);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
