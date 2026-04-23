import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

const { POST } = await import("./route");

function makeSupabase(result: {
  data?: { wine_id: string; remaining_ml: number; opened_at: string } | null;
  error?: { code?: string; message?: string } | null;
}) {
  return {
    rpc: (_fn: string, _args: unknown) => ({
      then: (resolve: (v: typeof result) => void) => resolve(result),
    }),
  };
}

function makeRequest(body: unknown): NextRequest {
  return {
    json: async () => body,
  } as NextRequest;
}

describe("POST /api/pour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await POST(makeRequest({ wine_id: "w-1", ml: 148 }));
    expect(res.status).toBe(401);
  });

  it("400s on invalid body", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase({ data: null, error: null }),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    const res = await POST(makeRequest({ ml: "five oz" }));
    expect(res.status).toBe(400);
  });

  it("returns 200 + open_bottle on happy path", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase({
        data: {
          wine_id: "11111111-1111-1111-1111-111111111111",
          remaining_ml: 602,
          opened_at: "2026-04-22T00:00:00Z",
        },
        error: null,
      }),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    const res = await POST(
      makeRequest({
        wine_id: "a1b2c3d4-e5f6-4789-8abc-def012345678",
        ml: 148,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.open_bottle.remaining_ml).toBe(602);
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("returns 409 on OUT_OF_STOCK", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase({
        data: null,
        error: { code: "P0001", message: "TERROIR_OUT_OF_STOCK" },
      }),
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    const res = await POST(
      makeRequest({
        wine_id: "a1b2c3d4-e5f6-4789-8abc-def012345678",
        ml: 148,
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("OUT_OF_STOCK");
  });

  it("returns 403 when RPC raises permission error", async () => {
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
        wine_id: "a1b2c3d4-e5f6-4789-8abc-def012345678",
        ml: 148,
      }),
    );
    expect(res.status).toBe(403);
  });
});
