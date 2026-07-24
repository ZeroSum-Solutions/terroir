import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
  requireRole: (...args: unknown[]) => auth.requireRole(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST: CREATE } = await import("./route");
const { POST: CLONE } = await import("./[id]/clone/route");
const { GET: CSV } = await import("./[id]/csv/route");
const { POST: PUBLISH, DELETE: UNPUBLISH } = await import(
  "./[id]/publish/route"
);

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const CLONE_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_ID = "33333333-3333-4333-8333-333333333333";
const RESTAURANT_ID = "44444444-4444-4444-8444-444444444444";

type DbError = { message: string; code?: string };
type Plan = {
  table: string;
  data?: unknown;
  error?: DbError | null;
};
type Call = {
  table: string;
  action: string;
  payload?: unknown;
  filters: Array<[string, unknown, string]>;
};

function makeSupabase(plans: Plan[]) {
  const calls: Call[] = [];
  const rpc = vi.fn();
  const from = vi.fn((table: string) => {
    const plan = plans.shift();
    if (!plan) throw new Error(`Unexpected database call to ${table}`);
    if (plan.table !== table) {
      throw new Error(`Expected ${plan.table}, received ${table}`);
    }
    const call: Call = { table, action: "query", filters: [] };
    calls.push(call);
    const result = () => ({
      data: plan.data ?? null,
      error: plan.error ?? null,
    });
    const chain = {
      select: (_columns?: string) => chain,
      insert: (payload: unknown) => {
        call.action = "insert";
        call.payload = payload;
        return chain;
      },
      update: (payload: unknown) => {
        call.action = "update";
        call.payload = payload;
        return chain;
      },
      delete: () => {
        call.action = "delete";
        return chain;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push([column, value, "eq"]);
        return chain;
      },
      neq: (column: string, value: unknown) => {
        call.filters.push([column, value, "neq"]);
        return chain;
      },
      order: (_column: string) => chain,
      maybeSingle: async () => result(),
      single: async () => result(),
      then: (
        resolve: (value: ReturnType<typeof result>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  });
  return { calls, client: { from, rpc } };
}

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function roleAuth(plans: Plan[]) {
  const supabase = makeSupabase(plans);
  auth.requireRole.mockResolvedValue({
    supabase: supabase.client,
    restaurantId: RESTAURANT_ID,
  });
  return supabase;
}

describe("wine-list lifecycle behavior", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes a partial create when default-section creation fails", async () => {
    const supabase = roleAuth([
      { table: "wine_lists", data: { id: LIST_ID } },
      {
        table: "wine_list_sections",
        error: { message: "section insert failed" },
      },
      { table: "wine_lists", data: { id: LIST_ID } },
    ]);

    const response = await CREATE(
      request("/api/wine-lists", "POST", { name: "Dinner" }),
    );

    expect(response.status).toBe(500);
    expect(supabase.calls[2]).toMatchObject({
      table: "wine_lists",
      action: "delete",
      filters: [
        ["id", LIST_ID, "eq"],
        ["restaurant_id", RESTAURANT_ID, "eq"],
      ],
    });
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });

  it("preserves display fields while cloning a list", async () => {
    const supabase = roleAuth([
      {
        table: "wine_lists",
        data: { name: "Dinner", description: "Evening", template: "modern" },
      },
      {
        table: "wine_list_sections",
        data: [
          {
            name: "Reds",
            position: 0,
            wine_list_items: [
              {
                wine_id: "wine-1",
                bottle_price: 80,
                glass_price: 18,
                glass_pour_ml: 150,
                pour_size_mode: "fixed",
                position: 0,
                is_available: true,
                tasting_note: "Cherry",
                name_override: "Reserve",
                blurb: "Old vines",
                hidden: true,
              },
            ],
          },
        ],
      },
      { table: "wine_lists", data: { id: CLONE_ID } },
      { table: "wine_list_sections", data: { id: SECTION_ID } },
      { table: "wine_list_items", data: [] },
    ]);

    const response = await CLONE(
      request(`/api/wine-lists/${LIST_ID}/clone`, "POST"),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(response.status).toBe(200);
    expect(supabase.calls[4].payload).toEqual([
      expect.objectContaining({
        section_id: SECTION_ID,
        name_override: "Reserve",
        blurb: "Old vines",
        hidden: true,
      }),
    ]);
  });

  it("removes a partial clone when a section insert fails", async () => {
    const supabase = roleAuth([
      {
        table: "wine_lists",
        data: { name: "Dinner", description: null, template: "classic" },
      },
      {
        table: "wine_list_sections",
        data: [{ name: "Reds", position: 0, wine_list_items: [] }],
      },
      { table: "wine_lists", data: { id: CLONE_ID } },
      {
        table: "wine_list_sections",
        error: { message: "section insert failed" },
      },
      { table: "wine_lists", data: { id: CLONE_ID } },
    ]);

    const response = await CLONE(
      request(`/api/wine-lists/${LIST_ID}/clone`, "POST"),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(response.status).toBe(500);
    expect(supabase.calls[4]).toMatchObject({
      action: "delete",
      filters: [
        ["id", CLONE_ID, "eq"],
        ["restaurant_id", RESTAURANT_ID, "eq"],
      ],
    });
  });

  it("distinguishes a clone provider failure from a missing list", async () => {
    roleAuth([
      { table: "wine_lists", error: { message: "provider unavailable" } },
    ]);

    const response = await CLONE(
      request(`/api/wine-lists/${LIST_ID}/clone`, "POST"),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(response.status).toBe(500);
  });

  it("neutralizes formula-like text in CSV cells", async () => {
    const supabase = makeSupabase([
      {
        table: "wine_lists",
        data: {
          name: "Dinner",
          wine_list_sections: [
            {
              name: "=Section",
              position: 0,
              wine_list_items: [
                {
                  position: 0,
                  glass_price: 18,
                  bottle_price: 80,
                  name_override: "  @Override",
                  hidden: false,
                  wines: {
                    producer: "+Producer",
                    name: "-Wine",
                    vintage: 2022,
                  },
                },
              ],
            },
          ],
        },
      },
    ]);
    auth.requireMembership.mockResolvedValue({
      supabase: supabase.client,
      restaurantId: RESTAURANT_ID,
    });

    const response = await CSV({} as Request, {
      params: Promise.resolve({ id: LIST_ID }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "'=Section,'+Producer,'-Wine,2022,18,80,'  @Override,No",
    );
  });

  it("returns a redacted 500 for a CSV provider failure", async () => {
    const supabase = makeSupabase([
      { table: "wine_lists", error: { message: "provider unavailable" } },
    ]);
    auth.requireMembership.mockResolvedValue({
      supabase: supabase.client,
      restaurantId: RESTAURANT_ID,
    });

    const response = await CSV({} as Request, {
      params: Promise.resolve({ id: LIST_ID }),
    });

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe(
      "Internal server error.",
    );
  });

  it("does not report publish success when no tenant row was updated", async () => {
    roleAuth([
      {
        table: "wine_lists",
        data: { slug: "dinner", restaurant_id: RESTAURANT_ID },
      },
      { table: "wine_lists", data: null },
    ]);

    const response = await PUBLISH(
      request(`/api/wine-lists/${LIST_ID}/publish`, "POST", {}),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(response.status).toBe(404);
  });

  it("maps a publish uniqueness race to slug_collision", async () => {
    roleAuth([
      {
        table: "wine_lists",
        data: { slug: "dinner", restaurant_id: RESTAURANT_ID },
      },
      {
        table: "wine_lists",
        error: { message: "duplicate", code: "23505" },
      },
    ]);

    const response = await PUBLISH(
      request(`/api/wine-lists/${LIST_ID}/publish`, "POST", {}),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("slug_collision");
  });

  it("does not report unpublish success when no tenant row was updated", async () => {
    roleAuth([
      { table: "wine_lists", data: { id: LIST_ID } },
      { table: "wine_lists", data: null },
    ]);

    const response = await UNPUBLISH(
      request(`/api/wine-lists/${LIST_ID}/publish`, "DELETE"),
      { params: Promise.resolve({ id: LIST_ID }) },
    );

    expect(response.status).toBe(404);
  });
});
