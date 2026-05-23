import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

const { POST } = await import("./route");

type RpcCall = { fn: string; args: unknown };

/**
 * Mock satisfies:
 *   - supabase.rpc('reconcile_open_bottles_batch', ...)  →  count
 *   - supabase.rpc('wine_published_list_slugs', ...)  →  slug rows
 *   - supabase.from('availability_events').select(...)
 *       .eq().eq().is().gte().in()  →  auto-86 event rows (ARCH-023)
 */
function makeSupabase(opts: {
  reconcile:
    | { data: number; error: null }
    | { data: null; error: { code?: string; message?: string } };
  autoEightysixedWineIds?: string[];
  publishedSlugs?: Array<{ slug: string }>;
}) {
  const calls: RpcCall[] = [];
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.push({ fn, args });
    if (fn === "reconcile_open_bottles_batch") {
      return Promise.resolve(opts.reconcile);
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
    const chain: Record<string, unknown> = {};
    const thenable = {
      select: () => thenable,
      eq: () => thenable,
      is: () => thenable,
      gte: () => thenable,
      in: () => thenable,
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
  return { supabase: { rpc, from }, calls };
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
    const { supabase } = makeSupabase({
      reconcile: { data: 0, error: null },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });
    const res = await POST(makeRequest({ entries: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with updated count on happy path (single atomic RPC)", async () => {
    const { supabase, calls } = makeSupabase({
      reconcile: { data: 2, error: null },
    });
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
    // Exactly ONE reconcile RPC call — the atomic batch.
    expect(
      calls.filter((c) => c.fn === "reconcile_open_bottles_batch"),
    ).toHaveLength(1);
    expect(mockRevalidate).toHaveBeenCalledWith("/availability");
  });

  it("returns 403 when the RPC raises permission error (42501)", async () => {
    const { supabase } = makeSupabase({
      reconcile: {
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
    const res = await POST(
      makeRequest({
        entries: [{ wine_id: UUID_A, new_remaining_ml: 375 }],
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 EXCEEDS_SIZE when RPC raises P0002", async () => {
    const { supabase } = makeSupabase({
      reconcile: {
        data: null,
        error: {
          code: "P0002",
          message: "p_new_remaining_ml exceeds bottle size (750)",
        },
      },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
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
    expect(body.error.code).toBe("EXCEEDS_SIZE");
  });

  // ARCH-023: auto-86 revalidation across a batch
  it("does NOT revalidate /list/* paths when no auto-86 events were inserted", async () => {
    const { supabase, calls } = makeSupabase({
      reconcile: { data: 2, error: null },
      autoEightysixedWineIds: [],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });
    await POST(
      makeRequest({
        entries: [
          { wine_id: UUID_A, new_remaining_ml: 375 },
          { wine_id: UUID_B, new_remaining_ml: 0 },
        ],
      }),
    );
    expect(
      mockRevalidate.mock.calls.some((c) =>
        String(c[0] ?? "").startsWith("/list/"),
      ),
    ).toBe(false);
    expect(calls.some((c) => c.fn === "wine_published_list_slugs")).toBe(
      false,
    );
  });

  it("revalidates /list/<slug> for every wine in the batch that got auto-86'd", async () => {
    const { supabase, calls } = makeSupabase({
      reconcile: { data: 2, error: null },
      // Only UUID_B got auto-86'd (its entry set remaining to 0).
      autoEightysixedWineIds: [UUID_B],
      publishedSlugs: [{ slug: "dinner-menu" }],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });
    await POST(
      makeRequest({
        entries: [
          { wine_id: UUID_A, new_remaining_ml: 375 },
          { wine_id: UUID_B, new_remaining_ml: 0 },
        ],
      }),
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/list/dinner-menu");
    const slugCalls = calls.filter(
      (c) => c.fn === "wine_published_list_slugs",
    );
    expect(slugCalls).toHaveLength(1);
    expect(slugCalls[0].args).toMatchObject({
      p_wine_id: UUID_B,
      p_restaurant_id: "r-A",
    });
  });
});
