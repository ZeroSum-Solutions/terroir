import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { PATCH } = await import("./route");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";

function request(body: unknown): NextRequest {
  return new Request(`http://localhost/api/cellar/${WINE_ID}/section`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeSupabase() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    calls.push({ method: "from", args: [table] });
    if (table === "wines") {
      return {
        select: () => ({
          eq: (column: string, value: string) => {
            calls.push({ method: "eq", args: [column, value] });
            return {
              eq: (nextColumn: string, nextValue: string) => {
                calls.push({
                  method: "eq",
                  args: [nextColumn, nextValue],
                });
                return {
                  single: async () => ({ data: { id: WINE_ID }, error: null }),
                };
              },
            };
          },
        }),
      };
    }
    if (table === "inventory_items") {
      return {
        update: (payload: Record<string, unknown>) => {
          calls.push({ method: "update", args: [payload] });
          return {
            eq: (column: string, value: string) => {
              calls.push({ method: "eq", args: [column, value] });
              return {
                eq: async (nextColumn: string, nextValue: string) => {
                  calls.push({
                    method: "eq",
                    args: [nextColumn, nextValue],
                  });
                  return { error: null };
                },
              };
            },
          };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from, calls };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "manager",
  });
}

describe("PATCH /api/cellar/[id]/section", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { status: 401 as const, actor: "unauthenticated caller" },
    { status: 403 as const, actor: "staff caller" },
  ])("preserves $actor precedence over invalid input", async ({ status }) => {
    const text = vi.fn();
    const supabase = makeSupabase();
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "denied" }, { status }),
    );

    const response = await PATCH({ text } as unknown as NextRequest, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(status);
    expect(text).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects an invalid UUID before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ section: "Reds" }), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["id"] }],
      },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request("{not-json"), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("rejects invalid known fields before business database access", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(request({ section: "" }), {
      params: Promise.resolve({ id: WINE_ID }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["section"] }],
      },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("trims the section and preserves both tenant predicates", async () => {
    const supabase = makeSupabase();
    allow(supabase);

    const response = await PATCH(
      request({ section: "  Cult Cabs  ", ignored_client_field: true }),
      { params: Promise.resolve({ id: WINE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      wine_id: WINE_ID,
      section: "Cult Cabs",
    });
    expect(supabase.calls).toContainEqual({
      method: "update",
      args: [{ section: "Cult Cabs" }],
    });
    expect(supabase.calls).toContainEqual({
      method: "eq",
      args: ["wine_id", WINE_ID],
    });
    expect(supabase.calls.filter((call) => call.method === "eq")).toContainEqual({
      method: "eq",
      args: ["restaurant_id", "restaurant-a"],
    });
  });
});
