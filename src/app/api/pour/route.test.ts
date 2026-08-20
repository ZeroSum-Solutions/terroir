import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
const mockCreateClient = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

const { POST } = await import("./route");

type RpcCall = { fn: string; args: unknown };

/**
 * Minimal mock that satisfies both:
 *   - supabase.rpc('record_pour', ...)  →  pour result
 *   - supabase.rpc('wine_published_list_slugs', ...)  →  slug rows
 *   - supabase.from('availability_events').select(...)
 *       .eq().eq().is().gte().in()  →  auto-86 event rows (ARCH-023)
 *
 * `autoEightysixedWineIds`: the set of wine IDs the DB reports
 *   were just auto-86'd by the pour trigger. Empty = no auto-86.
 * `publishedSlugs`: the slug rows returned by
 *   wine_published_list_slugs when called.
 */
function makeSupabase(opts: {
  recordPour: {
    data?: { wine_id: string; remaining_ml: number; opened_at: string } | null;
    error?: { code?: string; message?: string } | null;
  };
  autoEightysixedWineIds?: string[];
  publishedSlugs?: Array<{ slug: string }>;
  wineInRestaurant?: boolean;
  preservationError?: { code?: string; message?: string } | null;
}) {
  const calls: RpcCall[] = [];
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.push({ fn, args });
    if (fn === "record_pour") {
      return Promise.resolve(opts.recordPour);
    }
    if (fn === "wine_published_list_slugs") {
      return Promise.resolve({
        data: opts.publishedSlugs ?? [],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const from = vi.fn((table: string) => {
    if (table === "open_bottles") {
      const updateChain = {
        eq: () => updateChain,
        is: async () => ({ error: opts.preservationError ?? null }),
      };
      return { update: () => updateChain };
    }
    const chain: Record<string, unknown> = {};
    const thenable = {
      select: () => thenable,
      eq: () => thenable,
      is: () => thenable,
      gte: () => thenable,
      in: () => thenable,
      maybeSingle: async () => ({
        data: opts.wineInRestaurant === false ? null : { id: WINE_ID },
        error: null,
      }),
      then: (resolve: (v: unknown) => void) => {
        if (table === "availability_events") {
          resolve({
            data: (opts.autoEightysixedWineIds ?? []).map((id) => ({
              wine_id: id,
            })),
            error: null,
          });
        } else {
          resolve({ data: null, error: null });
        }
      },
    };
    Object.assign(chain, thenable);
    return chain;
  });
  const supabase = { rpc, from };
  return { supabase, calls };
}

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/pour", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";

describe("POST /api/pour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
  });

  it("401s when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await POST(makeRequest({ wine_id: "w-1", ml: 148 }));
    expect(res.status).toBe(401);
  });

  it("400s on invalid body", async () => {
    const { supabase } = makeSupabase({
      recordPour: { data: null, error: null },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    mockCreateClient.mockReturnValue(supabase);
    const res = await POST(makeRequest({ ml: "five oz" }));
    expect(res.status).toBe(400);
  });

  it("returns 200 + open_bottle on happy path", async () => {
    const { supabase } = makeSupabase({
      recordPour: {
        data: {
          wine_id: WINE_ID,
          remaining_ml: 602,
          opened_at: "2026-04-22T00:00:00Z",
        },
        error: null,
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    const res = await POST(makeRequest({ wine_id: WINE_ID, ml: 148 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.open_bottle.remaining_ml).toBe(602);
    expect(mockRevalidate).toHaveBeenCalledWith("/availability");
  });

  it("EV-10.1: applies a supplied preservation method to the bottle returned by record_pour", async () => {
    const { supabase } = makeSupabase({
      recordPour: {
        data: {
          wine_id: WINE_ID,
          remaining_ml: 602,
          opened_at: "2026-04-22T00:00:00Z",
        },
        error: null,
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    mockCreateClient.mockReturnValue(supabase);

    const response = await POST(makeRequest({
      wine_id: WINE_ID,
      ml: 148,
      preservation_method: "argon",
    }));

    expect(response.status).toBe(200);
    expect(supabase.from).toHaveBeenCalledWith("open_bottles");
  });

  it("rejects a wine outside the active restaurant before recording a pour", async () => {
    const { supabase, calls } = makeSupabase({
      recordPour: { data: null, error: null },
      wineInRestaurant: false,
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const response = await POST(makeRequest({ wine_id: WINE_ID, ml: 148 }));

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("returns the recorded pour with a warning when preservation update fails", async () => {
    const { supabase, calls } = makeSupabase({
      recordPour: {
        data: {
          wine_id: WINE_ID,
          remaining_ml: 602,
          opened_at: "2026-04-22T00:00:00Z",
        },
        error: null,
      },
      preservationError: { code: "XX000", message: "provider detail" },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    mockCreateClient.mockReturnValue(supabase);

    const response = await POST(makeRequest({
      wine_id: WINE_ID,
      ml: 148,
      preservation_method: "argon",
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).warning.code).toBe("preservation_update_failed");
    expect(calls.filter((call) => call.fn === "record_pour")).toHaveLength(1);
  });

  it("returns 409 on no inventory", async () => {
    const { supabase } = makeSupabase({
      recordPour: {
        data: null,
        error: { code: "P0001", message: "TERROIR_OUT_OF_STOCK" },
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    const res = await POST(makeRequest({ wine_id: WINE_ID, ml: 148 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("no_inventory");
  });

  it("returns 403 when RPC raises permission error", async () => {
    const { supabase } = makeSupabase({
      recordPour: {
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
    const res = await POST(makeRequest({ wine_id: WINE_ID, ml: 148 }));
    expect(res.status).toBe(403);
  });

  // ARCH-023: auto-86 revalidation
  it("does NOT revalidate /list/* paths when no auto-86 event was inserted", async () => {
    const { supabase, calls } = makeSupabase({
      recordPour: {
        data: { wine_id: WINE_ID, remaining_ml: 602, opened_at: "t" },
        error: null,
      },
      autoEightysixedWineIds: [],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    await POST(makeRequest({ wine_id: WINE_ID, ml: 148 }));
    expect(
      mockRevalidate.mock.calls.some((c) =>
        String(c[0] ?? "").startsWith("/list/"),
      ),
    ).toBe(false);
    // wine_published_list_slugs should NOT have been called — no event,
    // nothing to look up.
    expect(calls.some((c) => c.fn === "wine_published_list_slugs")).toBe(
      false,
    );
  });

  it("revalidates /list/<slug> for each published list when the pour auto-86'd the wine", async () => {
    const { supabase, calls } = makeSupabase({
      recordPour: {
        data: { wine_id: WINE_ID, remaining_ml: 0, opened_at: "t" },
        error: null,
      },
      autoEightysixedWineIds: [WINE_ID],
      publishedSlugs: [{ slug: "dinner-menu" }, { slug: "by-the-glass" }],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });
    const res = await POST(makeRequest({ wine_id: WINE_ID, ml: 148 }));
    expect(res.status).toBe(200);
    expect(mockRevalidate).toHaveBeenCalledWith("/list/dinner-menu");
    expect(mockRevalidate).toHaveBeenCalledWith("/list/by-the-glass");
    const slugCalls = calls.filter(
      (c) => c.fn === "wine_published_list_slugs",
    );
    expect(slugCalls).toHaveLength(1);
    expect(slugCalls[0].args).toMatchObject({
      p_wine_id: WINE_ID,
      p_restaurant_id: "r-A",
    });
  });
});
