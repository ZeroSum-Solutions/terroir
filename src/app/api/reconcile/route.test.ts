import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

const { POST } = await import("./route");

type RpcCall = { fn: string; args: Record<string, unknown> };

function makeSupabase(
  result:
    | { data: number; error: null }
    | { data: null; error: { code?: string; message?: string } },
) {
  const calls: RpcCall[] = [];
  return {
    _calls: calls,
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return {
        then: (resolve: (v: typeof result) => void) => resolve(result),
      };
    },
  };
}

function makeRequest(body: unknown): NextRequest {
  return { json: async () => body } as NextRequest;
}

const UUID_A = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const UUID_B = "b1b2c3d4-e5f6-4789-8abc-def012345679";

describe("POST /api/reconcile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await POST(makeRequest({ entries: [] }));
    expect(res.status).toBe(401);
  });

  it("400s on empty entries", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase({ data: 0, error: null }),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });
    const res = await POST(makeRequest({ entries: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with updated count on happy path (single atomic RPC)", async () => {
    const supabase = makeSupabase({ data: 2, error: null });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });
    const res = await POST(
      makeRequest({
        entries: [
          { wine_id: UUID_A, new_remaining_ml: 375 },
          { wine_id: UUID_B, new_remaining_ml: 0, note: "finished" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);
    // Exactly ONE RPC call — the atomic batch, not a per-entry loop.
    expect(supabase._calls).toHaveLength(1);
    expect(supabase._calls[0].fn).toBe("reconcile_open_bottles_batch");
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("returns 403 when the RPC raises permission error (42501)", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase({
        data: null,
        error: { code: "42501", message: "forbidden" },
      }),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    const res = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 EXCEEDS_SIZE when RPC raises P0002", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase({
        data: null,
        error: {
          code: "P0002",
          message: "p_new_remaining_ml exceeds bottle size (750)",
        },
      }),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });
    const res = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 7500 }],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("EXCEEDS_SIZE");
  });
});
