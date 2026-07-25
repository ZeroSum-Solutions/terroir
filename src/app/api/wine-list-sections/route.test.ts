import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

/**
 * POST /api/wine-list-sections tests (BND-025 / DEBT-005).
 *
 * The RPC mock enforces the same explicit restaurant/list pair as the SQL
 * boundary, so cross-tenant ids stay opaque even when RLS is bypassed.
 */

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { POST } = await import("./route");

type WineListRow = { id: string; restaurant_id: string };

let lastRpcPayload: Record<string, unknown> | null = null;
let sectionsCount = 0;
let insertError: { code: string; message: string } | null = null;

function makeSupabase(lists: WineListRow[]) {
  return {
    rpc: async (name: string, payload: Record<string, unknown>) => {
      expect(name).toBe("create_wine_list_section");
      lastRpcPayload = payload;
      const list = lists.find(
        (candidate) =>
          candidate.id === payload.p_wine_list_id &&
          candidate.restaurant_id === payload.p_restaurant_id,
      );
      if (!list) {
        return {
          data: null,
          error: { code: "T2105", message: "not found" },
        };
      }
      if (insertError) return { data: null, error: insertError };
      return {
        data: [{
          id: "section-new",
          wine_list_id: payload.p_wine_list_id,
          name: payload.p_name,
          position: sectionsCount,
          created_at: "2026-04-20T00:00:00Z",
        }],
        error: null,
      };
    },
  };
}

function postRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/wine-list-sections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("POST /api/wine-list-sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastRpcPayload = null;
    sectionsCount = 0;
    insertError = null;
  });

  it("401 on unauthenticated request", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    );
    const res = await POST(postRequest({ wine_list_id: "11111111-1111-4111-8111-111111111111", name: "Reds" }));
    expect(res.status).toBe(401);
    expect(lastRpcPayload).toBeNull();
  });

  it("400 on invalid JSON", async () => {
    mockRequireRole.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "r-A",
      user: { id: "u1" },
    });
    const res = await POST(postRequest("{not json"));
    expect(res.status).toBe(400);
    expect(lastRpcPayload).toBeNull();
  });

  it("400 on missing/empty name", async () => {
    mockRequireRole.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "r-A",
      user: { id: "u1" },
    });
    const res = await POST(postRequest({ wine_list_id: "11111111-1111-4111-8111-111111111111", name: "   " }));
    expect(res.status).toBe(400);
  });

  it("404 when the wine_list_id belongs to another restaurant (RLS-bypassed mock)", async () => {
    mockRequireRole.mockResolvedValue({
      supabase: makeSupabase([
        { id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-B" },
      ]),
      restaurantId: "r-A",
      user: { id: "u1" },
    });
    const res = await POST(postRequest({
      wine_list_id: "11111111-1111-4111-8111-111111111111",
      name: "Reds",
    }));
    expect(res.status).toBe(404);
    expect(lastRpcPayload).toEqual({
      p_restaurant_id: "r-A",
      p_wine_list_id: "11111111-1111-4111-8111-111111111111",
      p_name: "Reds",
    });
  });

  it("201 on happy path and delegates stable position allocation to the RPC", async () => {
    sectionsCount = 2; // list already has 2 sections → new one at index 2
    mockRequireRole.mockResolvedValue({
      supabase: makeSupabase([
        { id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-A" },
      ]),
      restaurantId: "r-A",
      user: { id: "u1" },
    });
    const res = await POST(postRequest({
      wine_list_id: "11111111-1111-4111-8111-111111111111",
      name: "Sparkling",
    }));
    expect(res.status).toBe(201);
    expect(lastRpcPayload).toEqual({
      p_restaurant_id: "r-A",
      p_wine_list_id: "11111111-1111-4111-8111-111111111111",
      p_name: "Sparkling",
    });
    const body = await res.json();
    expect(body.id).toBe("section-new");
    expect(body.position).toBe(2);
  });
});
