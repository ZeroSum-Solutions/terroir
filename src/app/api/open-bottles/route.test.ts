import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
const mockCreateClient = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
const mockRevalidatePath = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST } = await import("./route");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const ITEM_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";
const BOTTLE_ID = "c1b2c3d4-e5f6-4789-8abc-def012345678";

type Result<T> = { data: T | null; error: unknown };

function makeSupabase(options: {
  wine?: Result<{ id: string; restaurant_id: string; size_ml: number | null }>;
  sealed?: Result<{ id: string; quantity: number }>;
  decrementError?: unknown;
  existing?: Result<{ id: string; closed_at: null }>;
  replacement?: Result<{
    id: string;
    wine_id: string;
    remaining_ml: number;
    opened_at: string;
  }>;
}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const wine =
    options.wine ??
    ({
      data: { id: WINE_ID, restaurant_id: "restaurant-a", size_ml: 750 },
      error: null,
    } satisfies Result<{
      id: string;
      restaurant_id: string;
      size_ml: number | null;
    }>);
  const sealed =
    options.sealed ??
    ({
      data: { id: ITEM_ID, quantity: 3 },
      error: null,
    } satisfies Result<{ id: string; quantity: number }>);
  const existing =
    options.existing ??
    ({
      data: { id: BOTTLE_ID, closed_at: null },
      error: null,
    } satisfies Result<{ id: string; closed_at: null }>);
  const replacement =
    options.replacement ??
    ({
      data: {
        id: BOTTLE_ID,
        wine_id: WINE_ID,
        remaining_ml: 750,
        opened_at: "2026-07-24T00:00:00.000Z",
      },
      error: null,
    } satisfies Result<{
      id: string;
      wine_id: string;
      remaining_ml: number;
      opened_at: string;
    }>);

  function track(table: string, method: string, args: unknown[]) {
    calls.push({ table, method, args });
  }

  const from = vi.fn((table: string) => {
    if (table === "wines") {
      return {
        select: (...args: unknown[]) => {
          track(table, "select", args);
          return {
            eq: (...eqArgs: unknown[]) => {
              track(table, "eq", eqArgs);
              return { single: async () => wine };
            },
          };
        },
      };
    }

    if (table === "inventory_items") {
      return {
        select: (...args: unknown[]) => {
          track(table, "select", args);
          const chain = {
            eq: (...eqArgs: unknown[]) => {
              track(table, "eq", eqArgs);
              return chain;
            },
            gt: (...args: unknown[]) => {
              track(table, "gt", args);
              return chain;
            },
            order: (...args: unknown[]) => {
              track(table, "order", args);
              return chain;
            },
            limit: (...args: unknown[]) => {
              track(table, "limit", args);
              return chain;
            },
            single: async () => sealed,
          };
          return chain;
        },
        update: (payload: Record<string, unknown>) => {
          track(table, "update", [payload]);
          const chain = {
            eq: (...args: unknown[]) => {
              track(table, "eq", args);
              return chain;
            },
            then: (resolve: (value: unknown) => void) =>
              resolve({ error: options.decrementError ?? null }),
          };
          return chain;
        },
      };
    }

    if (table === "open_bottles") {
      return {
        select: (...args: unknown[]) => {
          track(table, "select", args);
          const chain = {
            eq: (...eqArgs: unknown[]) => {
              track(table, "eq", eqArgs);
              return chain;
            },
            is: (...args: unknown[]) => {
              track(table, "is", args);
              return chain;
            },
            maybeSingle: async () => existing,
          };
          return chain;
        },
        update: (payload: Record<string, unknown>) => {
          track(table, "update", [payload]);
          const chain = {
            eq: (...args: unknown[]) => {
              track(table, "eq", args);
              return chain;
            },
            select: (...selectArgs: unknown[]) => {
              track(table, "select", selectArgs);
              return { single: async () => replacement };
            },
          };
          return chain;
        },
      };
    }

    throw new Error(`Unexpected table ${table}`);
  });

  return { from, calls };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
  mockCreateClient.mockReturnValue(supabase);
}

function request(body: Record<string, unknown> = { wine_id: WINE_ID }): NextRequest {
  return new Request("http://localhost/api/open-bottles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function expectGeneric500(response: Response) {
  const text = await response.text();
  expect(response.status).toBe(500);
  expect(JSON.parse(text)).toEqual({
    error: {
      code: "internal_error",
      message: "Internal server error.",
    },
  });
  expect(text).not.toContain("super-secret");
}

describe("POST /api/open-bottles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
  });

  it("EV-10.1: persists preservation method and opened_by when manually opening", async () => {
    const supabase = makeSupabase({});
    allow(supabase);

    const response = await POST(
      request({ wine_id: WINE_ID, preservation_method: "coravin" }),
    );

    expect(response.status).toBe(201);
    expect(supabase.calls).toContainEqual({
      table: "open_bottles",
      method: "update",
      args: [expect.objectContaining({
        preservation_method: "coravin",
        opened_by: "user-a",
      })],
    });
  });

  it("keeps missing wine distinct from a provider failure", async () => {
    const supabase = makeSupabase({
      wine: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
    });
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Wine not found." },
    });
  });

  it("403s with a clear message when the wine belongs to a different restaurant", async () => {
    const supabase = makeSupabase({
      wine: {
        data: { id: WINE_ID, restaurant_id: "restaurant-b", size_ml: 750 },
        error: null,
      },
    });
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "forbidden",
        message:
          "This wine isn't in your restaurant. Refresh the page and try again.",
      },
    });
  });

  it("redacts a real wine-query failure", async () => {
    const supabase = makeSupabase({
      wine: {
        data: null,
        error: { code: "XX000", message: "super-secret wine failure" },
      },
    });
    allow(supabase);

    await expectGeneric500(await POST(request()));
  });

  it("keeps missing sealed stock distinct from a provider failure", async () => {
    const supabase = makeSupabase({
      sealed: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
    });
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "no_sealed_stock",
        message: "No sealed bottles available to open.",
      },
    });
  });

  it("redacts a real sealed-stock query failure", async () => {
    const supabase = makeSupabase({
      sealed: {
        data: null,
        error: { code: "XX000", message: "super-secret stock failure" },
      },
    });
    allow(supabase);

    await expectGeneric500(await POST(request()));
  });

  it("stops on an active-bottle lookup failure", async () => {
    const supabase = makeSupabase({
      existing: {
        data: null,
        error: { code: "XX000", message: "super-secret active failure" },
      },
    });
    allow(supabase);

    await expectGeneric500(await POST(request()));
    expect(
      supabase.calls.some(
        (call) => call.table === "inventory_items" && call.method === "update",
      ),
    ).toBe(false);
    expect(
      supabase.calls.some(
        (call) => call.table === "open_bottles" && call.method === "update",
      ),
    ).toBe(false);
  });

  it("preserves the 201 replacement envelope and tenant predicates", async () => {
    const supabase = makeSupabase({});
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      open_bottle: {
        id: BOTTLE_ID,
        wine_id: WINE_ID,
        remaining_ml: 750,
        opened_at: "2026-07-24T00:00:00.000Z",
      },
    });
    expect(supabase.calls).toContainEqual({
      table: "inventory_items",
      method: "eq",
      args: ["restaurant_id", "restaurant-a"],
    });
    expect(supabase.calls).toContainEqual({
      table: "open_bottles",
      method: "eq",
      args: ["restaurant_id", "restaurant-a"],
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/cellar/open");
  });
});
