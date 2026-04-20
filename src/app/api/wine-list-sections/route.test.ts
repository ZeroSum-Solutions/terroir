import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

/**
 * POST /api/wine-list-sections tests (BND-025 / DEBT-005).
 *
 * Behavioural coverage with the same RLS-bypassed-mock pattern we use
 * on wine-lists/[id]: the mock stores wine_lists rows for multiple
 * restaurants and only applies the filters the route issues. If the
 * route drops the `.eq('restaurant_id', …)` filter, cross-tenant rows
 * leak into the owner check and the 404 assertion breaks loudly.
 */

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { POST } = await import("./route");

type WineListRow = { id: string; restaurant_id: string };

// Module-level capture so tests can assert on insert payload.
let lastInsertPayload: Record<string, unknown> | null = null;
let sectionsCount = 0;
let insertError: { message: string } | null = null;

function makeSupabase(lists: WineListRow[]) {
  return {
    from: (table: string) => {
      const filters: Array<[string, string]> = [];
      const chain = {
        select: (_cols?: string, _opts?: { count?: "exact"; head?: boolean }) => chain,
        insert: (payload: Record<string, unknown>) => {
          lastInsertPayload = payload;
          return chain;
        },
        eq: (col: string, val: string) => {
          filters.push([col, val]);
          return chain;
        },
        maybeSingle: async () => {
          if (table !== "wine_lists") return { data: null, error: null };
          const matched = lists.find((r) =>
            filters.every(([col, val]) => {
              if (col === "id") return r.id === val;
              if (col === "restaurant_id") return r.restaurant_id === val;
              return true;
            }),
          );
          return { data: matched ?? null, error: null };
        },
        single: async () => {
          if (table === "wine_list_sections" && lastInsertPayload) {
            if (insertError) return { data: null, error: insertError };
            return {
              data: {
                id: "section-new",
                wine_list_id: lastInsertPayload.wine_list_id,
                name: lastInsertPayload.name,
                position: lastInsertPayload.position,
                created_at: "2026-04-20T00:00:00Z",
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then: (resolve: (v: { count: number | null; error: null }) => void) => {
          // Terminal await for the count(*) branch on wine_list_sections.
          if (table === "wine_list_sections") {
            resolve({ count: sectionsCount, error: null });
          } else {
            resolve({ count: null, error: null });
          }
        },
      };
      return chain;
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
    lastInsertPayload = null;
    sectionsCount = 0;
    insertError = null;
  });

  it("401 on unauthenticated request", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    );
    const res = await POST(postRequest({ wine_list_id: "11111111-1111-4111-8111-111111111111", name: "Reds" }));
    expect(res.status).toBe(401);
    expect(lastInsertPayload).toBeNull();
  });

  it("400 on invalid JSON", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "r-A",
      user: { id: "u1" },
    });
    const res = await POST(postRequest("{not json"));
    expect(res.status).toBe(400);
    expect(lastInsertPayload).toBeNull();
  });

  it("400 on missing/empty name", async () => {
    mockRequireMembership.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "r-A",
      user: { id: "u1" },
    });
    const res = await POST(postRequest({ wine_list_id: "11111111-1111-4111-8111-111111111111", name: "   " }));
    expect(res.status).toBe(400);
  });

  it("404 when the wine_list_id belongs to another restaurant (RLS-bypassed mock)", async () => {
    mockRequireMembership.mockResolvedValue({
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
    expect(lastInsertPayload).toBeNull();
  });

  it("201 on happy path, assigns position = existing count, inserts correct payload", async () => {
    sectionsCount = 2; // list already has 2 sections → new one at index 2
    mockRequireMembership.mockResolvedValue({
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
    expect(lastInsertPayload).toEqual({
      wine_list_id: "11111111-1111-4111-8111-111111111111",
      name: "Sparkling",
      position: 2,
    });
    const body = await res.json();
    expect(body.id).toBe("section-new");
    expect(body.position).toBe(2);
  });
});
