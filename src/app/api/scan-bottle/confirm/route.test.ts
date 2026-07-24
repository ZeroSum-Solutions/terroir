import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST } = await import("./route");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const ITEM_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";

function makeSupabase(options: {
  wine?: { data: { id: string } | null; error: unknown };
  inserted?: {
    data: {
      id: string;
      section: string;
      bin_location: string;
      added_at: string;
      wine_id: string;
    } | null;
    error: unknown;
  };
}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const wine = options.wine ?? { data: { id: WINE_ID }, error: null };
  const inserted = options.inserted ?? {
    data: {
      id: ITEM_ID,
      section: "Reds",
      bin_location: "A-1",
      added_at: "2026-07-24T00:00:00.000Z",
      wine_id: WINE_ID,
    },
    error: null,
  };
  const from = vi.fn((table: string) => {
    if (table === "wines") {
      const chain = {
        select: (...args: unknown[]) => {
          calls.push({ table, method: "select", args });
          return chain;
        },
        eq: (...args: unknown[]) => {
          calls.push({ table, method: "eq", args });
          return chain;
        },
        single: async () => wine,
      };
      return chain;
    }
    if (table === "inventory_items") {
      return {
        insert: (payload: unknown) => {
          calls.push({ table, method: "insert", args: [payload] });
          return {
            select: (...args: unknown[]) => {
              calls.push({ table, method: "select", args });
              return { single: async () => inserted };
            },
          };
        },
      };
    }
    throw new Error("Unexpected table " + table);
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
}

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/scan-bottle/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("POST /api/scan-bottle/confirm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects invalid location input before database access", async () => {
    const supabase = makeSupabase({});
    allow(supabase);

    const response = await POST(
      request({ wine_id: "nope", section: "", bin_location: "" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("returns a fixed 404 for a missing or foreign wine", async () => {
    const supabase = makeSupabase({
      wine: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
    });
    allow(supabase);

    const response = await POST(
      request({ wine_id: WINE_ID, section: "Reds", bin_location: "A-1" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "wine_not_found",
        message: "Wine not found or not in your restaurant.",
      },
    });
  });

  it("redacts a wine lookup provider failure", async () => {
    const supabase = makeSupabase({
      wine: {
        data: null,
        error: { code: "XX000", message: "super-secret lookup failure" },
      },
    });
    allow(supabase);

    const response = await POST(
      request({ wine_id: WINE_ID, section: "Reds", bin_location: "A-1" }),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("super-secret");
  });

  it("redacts an inventory insert failure", async () => {
    const supabase = makeSupabase({
      inserted: {
        data: null,
        error: { code: "XX000", message: "super-secret insert failure" },
      },
    });
    allow(supabase);

    const response = await POST(
      request({ wine_id: WINE_ID, section: "Reds", bin_location: "A-1" }),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("super-secret");
  });

  it("preserves staff success and authenticated tenant predicates", async () => {
    const supabase = makeSupabase({});
    allow(supabase);

    const response = await POST(
      request({ wine_id: WINE_ID, section: " Reds ", bin_location: " A-1 " }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      id: ITEM_ID,
      wine_id: WINE_ID,
      section: "Reds",
      bin_location: "A-1",
    });
    expect(supabase.calls).toContainEqual({
      table: "wines",
      method: "eq",
      args: ["restaurant_id", "restaurant-a"],
    });
    expect(supabase.calls).toContainEqual({
      table: "inventory_items",
      method: "insert",
      args: [
        expect.objectContaining({
          restaurant_id: "restaurant-a",
          wine_id: WINE_ID,
          section: "Reds",
          bin_location: "A-1",
        }),
      ],
    });
  });
});
