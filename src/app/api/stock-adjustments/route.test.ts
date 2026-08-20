import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { POST } = await import("./route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const REASON_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function request(body: unknown) {
  return new Request("http://localhost/api/stock-adjustments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as NextRequest;
}

function makeSupabase(options: {
  wine?: { id: string } | null;
  reason?: { id: string; category?: string } | null;
  insertError?: { message: string } | null;
} = {}) {
  const inserted: unknown[] = [];
  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    let insertPayload: unknown;
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      },
      insert: (payload: unknown) => {
        insertPayload = payload;
        inserted.push(payload);
        return query;
      },
      maybeSingle: async () => ({
        data: table === "wines"
          ? (options.wine === undefined ? { id: WINE_ID } : options.wine)
          : (options.reason === undefined ? { id: REASON_ID, category: "comp" } : options.reason),
        error: null,
      }),
      single: async () => ({
        data: {
          id: "adjustment-1",
          kind: "comp",
          bottles: 1,
          ml: 0,
          reason_code_id: REASON_ID,
          note: "guest recovery",
          created_at: "2026-08-19T12:00:00.000Z",
          ...(typeof insertPayload === "object" ? insertPayload : {}),
        },
        error: options.insertError ?? null,
      }),
    };
    return query;
  });
  return { client: { from }, from, inserted };
}

function allow(client: ReturnType<typeof makeSupabase>["client"]) {
  mockRequireMembership.mockResolvedValue({
    supabase: client,
    restaurantId: "restaurant-a",
    user: { id: "session-user" },
    role: "staff",
  });
}

describe("POST /api/stock-adjustments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the membership denial before parsing the body", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    expect((await POST(request("{bad"))).status).toBe(401);
  });

  it("EV-7.1: ignores client member ids and persists the session user", async () => {
    const supabase = makeSupabase();
    allow(supabase.client);

    const response = await POST(request({
      wine_id: WINE_ID,
      kind: "comp",
      bottles: 1,
      reason_code_id: REASON_ID,
      note: "guest recovery",
      acting_user_id: CLIENT_ACTOR_ID,
      member_id: CLIENT_ACTOR_ID,
    }));

    expect(response.status).toBe(201);
    expect(supabase.inserted).toEqual([{
      restaurant_id: "restaurant-a",
      wine_id: WINE_ID,
      kind: "comp",
      bottles: 1,
      ml: 0,
      reason_code_id: REASON_ID,
      note: "guest recovery",
      acting_user_id: "session-user",
    }]);
  });

  it("EV-7.2: returns 422 invalid_reason_code when the reason is inactive or out of tenant", async () => {
    const supabase = makeSupabase({ reason: null });
    allow(supabase.client);

    const response = await POST(request({
      wine_id: WINE_ID,
      kind: "comp",
      ml: 150,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_reason_code",
        message: "Reason code must be active for this restaurant.",
      },
    });
    expect(supabase.inserted).toHaveLength(0);
  });

  it("EV-7.2: links a valid reason on the inserted event", async () => {
    const supabase = makeSupabase({
      reason: { id: REASON_ID, category: "adjustment" },
    });
    allow(supabase.client);

    const response = await POST(request({
      wine_id: WINE_ID,
      kind: "adjustment",
      bottles: -1,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(201);
    expect(supabase.inserted[0]).toEqual(expect.objectContaining({
      kind: "adjustment",
      bottles: -1,
      reason_code_id: REASON_ID,
    }));
  });

  it("rejects missing quantity and a wine outside the active restaurant", async () => {
    const supabase = makeSupabase({ wine: null });
    allow(supabase.client);

    const missingQuantity = await POST(request({
      wine_id: WINE_ID,
      kind: "comp",
      reason_code_id: REASON_ID,
    }));
    const wrongRestaurant = await POST(request({
      wine_id: WINE_ID,
      kind: "comp",
      bottles: 1,
      reason_code_id: REASON_ID,
    }));

    expect(missingQuantity.status).toBe(400);
    expect(wrongRestaurant.status).toBe(404);
    expect(supabase.inserted).toHaveLength(0);
  });
});
