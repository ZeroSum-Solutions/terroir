import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@/lib/api/idempotency", () => ({
  createIdempotencyRequestHash: () => "a".repeat(64),
  isValidIdempotencyKey: () => false,
  withIdempotency: async (options: {
    handler: () => Promise<{ status: number; body: unknown }>;
  }) => ({ ...(await options.handler()), replayed: false }),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST } = await import("./route");
const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";

function makeSupabase(options: {
  batch?: { data: string[] | null; error: unknown };
  inventoryError?: unknown;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    rpc: vi.fn((fn: string, args: unknown) => {
      calls.push({ method: "rpc:" + fn, args: [args] });
      if (fn === "find_or_create_wines_batch") {
        return Promise.resolve(
          options.batch ?? { data: [WINE_ID], error: null },
        );
      }
      if (fn === "match_lwin_batch") {
        return Promise.resolve({ data: [], error: null });
      }
      throw new Error("Unexpected RPC " + fn);
    }),
    from: vi.fn((table: string) => {
      if (table !== "inventory_items") {
        throw new Error("Unexpected table " + table);
      }
      return {
        insert: async (payload: unknown) => {
          calls.push({ method: "inventory:insert", args: [payload] });
          return { error: options.inventoryError ?? null };
        },
      };
    }),
  };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

function request(overrides: Record<string, unknown> = {}): NextRequest {
  return new Request("http://localhost/api/inventory/save-bottle-scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wine: {
        name: " Volnay ",
        producer: " Domaine Test ",
        vintage: 2021,
        varietal: "Pinot Noir",
        region: "Burgundy",
        country: "France",
        qty: 2,
        unitCost: 42.5,
        ...overrides,
      },
    }),
  }) as unknown as NextRequest;
}

describe("POST /api/inventory/save-bottle-scan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects fractional quantities before persistence", async () => {
    const supabase = makeSupabase({});
    allow(supabase);

    const response = await POST(request({ qty: 1.5 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["wine", "qty"] }],
      },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "provider error",
      batch: {
        data: null,
        error: { code: "XX000", message: "super-secret RPC failure" },
      },
    },
    { name: "empty result", batch: { data: [], error: null } },
  ])("redacts a wine batch $name", async ({ batch }) => {
    const supabase = makeSupabase({ batch });
    allow(supabase);

    const response = await POST(request());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(text).not.toContain("super-secret");
  });

  it("redacts an inventory insert failure", async () => {
    const supabase = makeSupabase({
      inventoryError: {
        code: "XX000",
        message: "super-secret inventory failure",
      },
    });
    allow(supabase);

    const response = await POST(request());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("super-secret");
  });

  it("preserves staff success and authenticated tenant payloads", async () => {
    const supabase = makeSupabase({});
    allow(supabase);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wineId: WINE_ID });
    expect(supabase.calls).toContainEqual({
      method: "rpc:find_or_create_wines_batch",
      args: [
        expect.objectContaining({
          p_restaurant_id: "restaurant-a",
          p_wines: [
            expect.objectContaining({
              name: "Volnay",
              producer: "Domaine Test",
            }),
          ],
        }),
      ],
    });
    expect(supabase.calls).toContainEqual({
      method: "inventory:insert",
      args: [
        expect.objectContaining({
          restaurant_id: "restaurant-a",
          wine_id: WINE_ID,
          quantity: 2,
        }),
      ],
    });
  });
});
