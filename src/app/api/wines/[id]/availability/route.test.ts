import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

const { PATCH } = await import("./route");

type WineScopeRow = { id: string; restaurant_id: string };
type RpcEventRow = {
  id: string;
  wine_id: string;
  restaurant_id: string;
  direction: "eightysixed" | "restored";
  user_id: string | null;
  note: string | null;
  created_at: string;
};

function makeSupabase(opts: {
  wineRows: WineScopeRow[];
  // set_wine_availability RPC returns SETOF, so `data` is an array.
  rpcResult: { data: RpcEventRow[] | null; error: unknown };
  // ARCH-019: wine_published_list_slugs RPC returns the slugs of
  // every published wine list referencing the target wine. Each row
  // has a non-null slug by definition (filtered inside the RPC), so
  // the shape is simpler than the previous embed-based response.
  publishedLists?: Array<{ slug: string }>;
}) {
  const calls = { rpc: [] as Array<{ fn: string; args: unknown }> };
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.rpc.push({ fn, args });
    if (fn === "set_wine_availability") {
      return Promise.resolve(opts.rpcResult);
    }
    if (fn === "wine_published_list_slugs") {
      return Promise.resolve({ data: opts.publishedLists ?? [], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const from = vi.fn((table: string) => {
    const filters: Array<[string, string]> = [];
    const chain = {
      select: () => chain,
      eq: (col: string, val: string) => {
        filters.push([col, val]);
        return chain;
      },
      maybeSingle: async () => {
        if (table !== "wines") return { data: null, error: null };
        const match = opts.wineRows.find((r) =>
          filters.every(([c, v]) =>
            c === "id"
              ? r.id === v
              : c === "restaurant_id"
                ? r.restaurant_id === v
                : true,
          ),
        );
        return { data: match ?? null, error: null };
      },
    };
    return chain;
  });
  return { supabase: { from, rpc }, calls };
}

function patchRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/wines/11111111-1111-4111-8111-111111111111/availability", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

const WINE_PARAMS = () => ({ params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) });

describe("PATCH /api/wines/[id]/availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when requireRole returns 401 NextResponse", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await PATCH(
      patchRequest({ direction: "eightysixed" }),
      WINE_PARAMS(),
    );
    expect(res.status).toBe(401);
  });

  it("403 when requireRole returns 403 NextResponse (staff)", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json(
        { error: "Role owner or manager required." },
        { status: 403 },
      ),
    );
    const res = await PATCH(
      patchRequest({ direction: "eightysixed" }),
      WINE_PARAMS(),
    );
    expect(res.status).toBe(403);
  });

  it("400 on invalid JSON", async () => {
    const { supabase } = makeSupabase({
      wineRows: [{ id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-A" }],
      rpcResult: { data: [], error: null },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const req = new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }) as unknown as NextRequest;
    const res = await PATCH(req, WINE_PARAMS());
    expect(res.status).toBe(400);
  });

  it("400 on missing direction", async () => {
    const { supabase } = makeSupabase({
      wineRows: [{ id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-A" }],
      rpcResult: { data: [], error: null },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(patchRequest({}), WINE_PARAMS());
    expect(res.status).toBe(400);
  });

  it("400 on invalid direction value", async () => {
    const { supabase } = makeSupabase({
      wineRows: [{ id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-A" }],
      rpcResult: { data: [], error: null },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      patchRequest({ direction: "gone" }),
      WINE_PARAMS(),
    );
    expect(res.status).toBe(400);
  });

  it("404 when wine belongs to another restaurant (RLS-bypassed mock)", async () => {
    const { supabase } = makeSupabase({
      wineRows: [{ id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-OTHER" }],
      rpcResult: { data: [], error: null },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      patchRequest({ direction: "eightysixed" }),
      WINE_PARAMS(),
    );
    expect(res.status).toBe(404);
  });

  it("200 {changed:false} when RPC returns empty set (idempotent no-op)", async () => {
    const { supabase, calls } = makeSupabase({
      wineRows: [{ id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-A" }],
      rpcResult: { data: [], error: null },
      publishedLists: [],
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      patchRequest({ direction: "eightysixed" }),
      WINE_PARAMS(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(false);
    expect(calls.rpc).toHaveLength(2);
    expect(calls.rpc[0].fn).toBe("set_wine_availability");
    expect(calls.rpc[1].fn).toBe("wine_published_list_slugs");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("200 {changed:true, event} on happy path and revalidates each affected published list", async () => {
    const event: RpcEventRow = {
      id: "ev-1",
      wine_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "r-A",
      direction: "eightysixed",
      user_id: "u-1",
      note: "last bottle just poured",
      created_at: "2026-04-21T19:00:00Z",
    };
    const { supabase, calls } = makeSupabase({
      wineRows: [{ id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-A" }],
      rpcResult: { data: [event], error: null },
      // ARCH-019: RPC-backed revalidation returns only non-null slugs
      // (filter lives in SQL now).
      publishedLists: [{ slug: "dinner" }, { slug: "btg" }],
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      patchRequest({
        direction: "eightysixed",
        note: "last bottle just poured",
      }),
      WINE_PARAMS(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(true);
    // ARCH-018: response is narrowed — direction + occurred_at only.
    // user_id / restaurant_id / id / note are intentionally absent.
    expect(body.event).toEqual({
      direction: "eightysixed",
      occurred_at: "2026-04-21T19:00:00Z",
    });
    expect(body.event.user_id).toBeUndefined();
    expect(body.event.restaurant_id).toBeUndefined();

    expect(calls.rpc[0].fn).toBe("set_wine_availability");
    expect(calls.rpc[0].args).toEqual({
      p_wine_id: "11111111-1111-4111-8111-111111111111",
      p_direction: "eightysixed",
      p_note: "last bottle just poured",
    });
    // Second RPC call is the revalidation query.
    expect(calls.rpc[1].fn).toBe("wine_published_list_slugs");
    expect(calls.rpc[1].args).toEqual({
      p_wine_id: "11111111-1111-4111-8111-111111111111",
      p_restaurant_id: "r-A",
    });

    expect(mockRevalidatePath).toHaveBeenCalledTimes(2);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/dinner");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/btg");
  });

  it("500 on RPC error", async () => {
    const { supabase } = makeSupabase({
      wineRows: [{ id: "11111111-1111-4111-8111-111111111111", restaurant_id: "r-A" }],
      rpcResult: { data: null, error: { message: "boom" } },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "owner",
    });
    const res = await PATCH(
      patchRequest({ direction: "eightysixed" }),
      WINE_PARAMS(),
    );
    expect(res.status).toBe(500);
  });
});
