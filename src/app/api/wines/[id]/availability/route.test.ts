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
type PublishedListRow = { slug: string | null };
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
  // RPC returns SETOF, so `data` is an array (or null on error).
  rpcResult: { data: RpcEventRow[] | null; error: unknown };
  publishedLists?: PublishedListRow[];
}) {
  const calls = { rpc: [] as Array<{ fn: string; args: unknown }> };
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.rpc.push({ fn, args });
    return Promise.resolve(opts.rpcResult);
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
      then: (
        resolve: (v: { data: PublishedListRow[]; error: null }) => void,
      ) => {
        if (table === "wine_lists") {
          resolve({ data: opts.publishedLists ?? [], error: null });
        } else {
          resolve({ data: [], error: null });
        }
      },
    };
    return chain;
  });
  return { supabase: { from, rpc }, calls };
}

function patchRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/wines/w-1/availability", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

const WINE_PARAMS = () => ({ params: Promise.resolve({ id: "w-1" }) });

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
      wineRows: [{ id: "w-1", restaurant_id: "r-A" }],
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
      wineRows: [{ id: "w-1", restaurant_id: "r-A" }],
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
      wineRows: [{ id: "w-1", restaurant_id: "r-A" }],
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
      wineRows: [{ id: "w-1", restaurant_id: "r-OTHER" }],
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
      wineRows: [{ id: "w-1", restaurant_id: "r-A" }],
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
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].fn).toBe("set_wine_availability");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("200 {changed:true, event} on happy path and revalidates each affected published list", async () => {
    const event: RpcEventRow = {
      id: "ev-1",
      wine_id: "w-1",
      restaurant_id: "r-A",
      direction: "eightysixed",
      user_id: "u-1",
      note: "last bottle just poured",
      created_at: "2026-04-21T19:00:00Z",
    };
    const { supabase, calls } = makeSupabase({
      wineRows: [{ id: "w-1", restaurant_id: "r-A" }],
      rpcResult: { data: [event], error: null },
      publishedLists: [{ slug: "dinner" }, { slug: "btg" }, { slug: null }],
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
    expect(body.event).toEqual(event);

    expect(calls.rpc[0].args).toEqual({
      p_wine_id: "w-1",
      p_direction: "eightysixed",
      p_note: "last bottle just poured",
    });

    // Both lists with non-null slugs revalidated. The slug=null list is skipped.
    expect(mockRevalidatePath).toHaveBeenCalledTimes(2);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/dinner");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/btg");
  });

  it("500 on RPC error", async () => {
    const { supabase } = makeSupabase({
      wineRows: [{ id: "w-1", restaurant_id: "r-A" }],
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
