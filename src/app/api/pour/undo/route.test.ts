import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const { POST } = await import("./route");

type RpcCall = { fn: string; args: unknown };

function makeSupabase(opts: {
  undo:
    | { data: { wine_id: string; remaining_ml: number } | null; error: null }
    | { data: null; error: { code?: string; message?: string } };
}) {
  const calls: RpcCall[] = [];
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.push({ fn, args });
    if (fn === "undo_last_pour") return Promise.resolve(opts.undo);
    if (fn === "wine_published_list_slugs") {
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const from = vi.fn(() => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      gte: () => chain,
      in: () => Promise.resolve({ data: [], error: null }),
    };
    return chain;
  });
  return { supabase: { rpc, from }, calls };
}

function makeRequest(body: unknown): NextRequest {
  return { json: async () => body } as NextRequest;
}

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";

describe("POST /api/pour/undo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await POST(makeRequest({ wine_id: WINE_ID }));

    expect(res.status).toBe(401);
  });

  it("undoes the latest pour through the domain service", async () => {
    const { supabase, calls } = makeSupabase({
      undo: { data: { wine_id: WINE_ID, remaining_ml: 602 }, error: null },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST(makeRequest({ wine_id: WINE_ID }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      open_bottle: { wine_id: WINE_ID, remaining_ml: 602 },
    });
    expect(calls).toContainEqual({
      fn: "undo_last_pour",
      args: { p_wine_id: WINE_ID },
    });
    expect(mockRevalidate).toHaveBeenCalledWith("/availability");
  });

  it("returns 404 when there is no recent pour to undo", async () => {
    const { supabase } = makeSupabase({
      undo: {
        data: null,
        error: { code: "P0001", message: "no recent pour to undo" },
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST(makeRequest({ wine_id: WINE_ID }));

    expect(res.status).toBe(404);
  });

  it("returns 403 when the RPC raises permission error", async () => {
    const { supabase } = makeSupabase({
      undo: {
        data: null,
        error: { code: "42501", message: "forbidden" },
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await POST(makeRequest({ wine_id: WINE_ID }));

    expect(res.status).toBe(403);
  });
});

