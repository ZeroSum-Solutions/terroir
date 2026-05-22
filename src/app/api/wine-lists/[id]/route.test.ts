import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * /api/wine-lists/[id] route tests.
 *
 * Covers:
 * - BND-008: cross-tenant PATCH/DELETE must 404
 * - BND-156: slug uniqueness scoped per-restaurant, code "slug_collision" on 409
 * - BND-159: DELETE requires archived=true, returns 409 with code "must_archive_first"
 */

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { PATCH, DELETE } = await import("./route");

type Row = { id: string; restaurant_id: string; slug?: string; archived?: boolean };

/**
 * Build a mock supabase client whose tables hold `rows`.
 *
 * Supports these chain patterns:
 * - Query chain: .select("cols").eq().eq().neq().maybeSingle() → { data: row|null, error }
 * - Query chain: .select("cols").eq().eq().single() → { data: row|null, error }
 * - Mutation chain: .update(p).eq().eq().select("cols") → filters rows, returns matched
 * - Mutation chain: .delete().eq().eq().select("cols") → filters rows, returns matched
 *
 * For multiple from() calls, tracks a counter and returns data from per-call config.
 */
let lastUpdatePayload: Record<string, unknown> | null = null;
let selectError: { message: string } | null = null;
let fromCallCount = 0;

// Per-call response overrides
type CallOverride = {
  table?: string;
  data?: any;
  error?: { message: string } | null;
};
let callOverrides: CallOverride[] = [];

function makeSupabase(rows: Row[]) {
  fromCallCount = 0;

  return {
    from: (table: string) => {
      const callIdx = fromCallCount++;
      const override = callOverrides[callIdx];

      // --- Query-builder chain (select-first pattern) ---
      const queryFilters: Array<[string, unknown, string]> = [];
      const queryChain = {
        eq: (col: string, val: unknown) => {
          queryFilters.push([col, val, "eq"]);
          return queryChain;
        },
        neq: (col: string, val: unknown) => {
          queryFilters.push([col, val, "neq"]);
          return queryChain;
        },
        maybeSingle: async () => {
          if (override?.error) return { data: null, error: override.error };
          if (override?.data !== undefined) return { data: override.data, error: null };
          const matched = rows.filter((r) =>
            queryFilters.every(([col, val, op]) => {
              if (op === "neq") return (r as any)[col] !== val;
              return (r as any)[col] === val;
            }),
          );
          return { data: matched.length > 0 ? matched[0] : null, error: null };
        },
        single: async () => {
          if (override?.error) return { data: null, error: override.error };
          if (override?.data !== undefined) return { data: override.data, error: null };
          const matched = rows.filter((r) =>
            queryFilters.every(([col, val, op]) => {
              if (op === "neq") return (r as any)[col] !== val;
              return (r as any)[col] === val;
            }),
          );
          if (matched.length === 0) return { data: null, error: { message: "not found", code: "PGRST116" } };
          return { data: matched[0], error: null };
        },
        order: () => queryChain,
        // Support `await supabase.from(...).select(...).eq(...)` — the
        // query chain is thenable so it acts like a Promise<{ data, error }>.
        then: (resolve: (value: { data: any[] | null; error: any }) => void) => {
          if (override?.error) return resolve({ data: null, error: override.error });
          if (override?.data !== undefined) return resolve({ data: override.data, error: null });
          const matched = rows.filter((r) =>
            queryFilters.every(([col, val, op]) => {
              if (op === "neq") return (r as any)[col] !== val;
              return (r as any)[col] === val;
            }),
          );
          resolve({ data: matched, error: null });
        },
      };

      // --- Mutation chain (update/delete-first pattern) ---
      const mutFilters: Array<[string, string]> = [];
      const mutChain = {
        update: (payload: Record<string, unknown>) => {
          lastUpdatePayload = payload;
          return mutChain;
        },
        delete: () => mutChain,
        eq: (col: string, val: string) => {
          mutFilters.push([col, val]);
          return mutChain;
        },
        in: (_col: string, _vals: unknown) => mutChain,
        select: async (_cols?: string) => {
          if (override?.error) return { data: null, error: override.error };
          if (override?.data !== undefined) return { data: override.data, error: null };
          if (selectError) return { data: null, error: selectError };
          const matched = rows.filter((r) =>
            mutFilters.every(([col, val]) => {
              if (col === "id") return r.id === val;
              if (col === "restaurant_id") return r.restaurant_id === val;
              return true;
            }),
          );
          return { data: matched, error: null };
        },
      };

      return {
        select: (_cols?: string) => queryChain,
        update: (payload: Record<string, unknown>) => {
          lastUpdatePayload = payload;
          return mutChain;
        },
        delete: () => mutChain,
      };
    },
  };
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/wine-lists/list-a", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function deleteRequest() {
  return new Request("http://localhost/api/wine-lists/list-a", {
    method: "DELETE",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe("PATCH /api/wine-lists/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastUpdatePayload = null;
    selectError = null;
    callOverrides = [];
  });

  it("returns 404 when the target list belongs to a different restaurant (RLS-bypassed mock)", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-B" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await PATCH(patchRequest({ name: "renamed" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(404);
  });

  it("returns 200 for a same-restaurant update", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await PATCH(patchRequest({ name: "renamed" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects an empty update body with 400", async () => {
    mockRequireRole.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({}), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(400);
  });

  it("propagates the 401 from requireRole", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await PATCH(patchRequest({ name: "x" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s on malformed JSON body (distinct from empty-body 400)", async () => {
    mockRequireRole.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const req = new Request("http://localhost/api/wine-lists/list-a", {
      method: "PATCH",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const res = await PATCH(req, { params: Promise.resolve({ id: "list-a" }) });
    expect(res.status).toBe(400);
  });

  it("filters unsafe fields from the update payload (only allows name + template + slug + archived)", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(
      patchRequest({
        name: "clean",
        template: "elegant",
        slug: "my-custom-slug",
        is_published: true,
        restaurant_id: "restaurant-B",
      }),
      { params: Promise.resolve({ id: "list-a" }) },
    );
    expect(res.status).toBe(200);
    // Critical: only the allowlisted fields made it to the UPDATE payload.
    expect(lastUpdatePayload).toEqual({
      name: "clean",
      template: "elegant",
      slug: "my-custom-slug",
    });
    expect(lastUpdatePayload).not.toHaveProperty("is_published");
    expect(lastUpdatePayload).not.toHaveProperty("restaurant_id");
  });

  it("rejects empty slug with 422", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({ slug: "   " }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects invalid slug characters with 422", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({ slug: "My Bad Slug!" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects slug that is too long with 422", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(
      patchRequest({ slug: "a".repeat(51) }),
      { params: Promise.resolve({ id: "list-a" }) },
    );
    expect(res.status).toBe(422);
  });

  it("returns 409 with code slug_collision on same-restaurant slug conflict (BND-156)", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
      { id: "list-b", restaurant_id: "restaurant-A", slug: "taken-slug" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({ slug: "taken-slug" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("slug_collision");
  });

  it("allows same slug in a different restaurant (BND-156 scoping)", async () => {
    // list-b in restaurant-B has slug "dinner". list-a in restaurant-A
    // wants "dinner" — should be allowed because slugs are scoped per-restaurant.
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
      { id: "list-b", restaurant_id: "restaurant-B", slug: "dinner" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({ slug: "dinner" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(200);
    expect(lastUpdatePayload).toHaveProperty("slug", "dinner");
  });

  it("accepts valid slug with 200", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({ slug: "spring-2026" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(200);
    expect(lastUpdatePayload).toHaveProperty("slug", "spring-2026");
  });

  it("returns 500 when the Supabase update errors", async () => {
    selectError = { message: "constraint violation" };
    mockRequireRole.mockResolvedValue({
      supabase: makeSupabase([
        { id: "list-a", restaurant_id: "restaurant-A" },
      ]),
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await PATCH(patchRequest({ name: "x" }), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/wine-lists/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastUpdatePayload = null;
    selectError = null;
    callOverrides = [];
  });

  it("returns 404 when the target list belongs to a different restaurant (RLS-bypassed mock)", async () => {
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-B" },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 with code must_archive_first when list is not archived (BND-159)", async () => {
    // First from() call: fetch the list to check archived status
    callOverrides = [
      { data: { id: "list-a", archived: false }, error: null },
    ];
    const supabase = makeSupabase([]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("must_archive_first");
  });

  it("returns 200 for a same-restaurant delete of an archived list (BND-159)", async () => {
    // First from() call: fetch the list (archived=true)
    // Second from() call: wine_list_items delete
    // Third from() call: wine_list_sections delete
    // Fourth from() call: wine_lists delete
    callOverrides = [
      { data: { id: "list-a", archived: true }, error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [{ id: "list-a", restaurant_id: "restaurant-A" }], error: null },
    ];
    const supabase = makeSupabase([
      { id: "list-a", restaurant_id: "restaurant-A", archived: true },
    ]);
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("propagates the 401 from requireRole", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 500 when the pre-delete fetch errors", async () => {
    callOverrides = [
      { error: { message: "db error" } },
    ];
    mockRequireRole.mockResolvedValue({
      supabase: makeSupabase([]),
      restaurantId: "restaurant-A",
      user: { id: "u1" },
    });
    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "list-a" }),
    });
    expect(res.status).toBe(500);
  });
});
