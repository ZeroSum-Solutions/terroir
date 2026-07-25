import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireRole = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST: CREATE } = await import("./route");
const { PATCH: UPDATE, DELETE: REMOVE } = await import("./[id]/route");
const { PATCH: REORDER } = await import("./reorder/route");

const VALID_ID = "11111111-1111-4111-8111-111111111111";

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function watchedParams(id = VALID_ID) {
  let touches = 0;
  const params = {
    then(resolve: (value: { id: string }) => void) {
      touches += 1;
      resolve({ id });
    },
  } as unknown as Promise<{ id: string }>;
  return { params, touches: () => touches };
}

type QueryResult = { data: unknown; error: unknown };

function queryEndingIn(
  terminal: "maybeSingle" | "single" | "limit" | "in",
  result: QueryResult,
) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of [
    "select",
    "eq",
    "in",
    "order",
    "limit",
    "insert",
    "update",
    "delete",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query[terminal] = vi.fn(async () => result);
  return query;
}

describe("wine-list item API boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const operation of [
    {
      name: "PATCH item",
      call: (params: Promise<{ id: string }>) =>
        UPDATE(
          request(`/api/wine-list-items/${VALID_ID}`, "PATCH", {
            glass_price: 14,
          }),
          { params },
        ),
    },
    {
      name: "DELETE item",
      call: (params: Promise<{ id: string }>) =>
        REMOVE({} as NextRequest, { params }),
    },
  ]) {
    it(`${operation.name} returns the exact auth denial before resolving params`, async () => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      mockRequireRole.mockResolvedValue(denial);
      const watched = watchedParams();

      const response = await operation.call(watched.params);

      expect(response).toBe(denial);
      expect(watched.touches()).toBe(0);
    });

    it(`${operation.name} rejects an invalid UUID before database work`, async () => {
      const from = vi.fn(() => {
        throw new Error("database must not run");
      });
      mockRequireRole.mockResolvedValue({
        supabase: { from },
        restaurantId: "22222222-2222-4222-8222-222222222222",
      });

      const response = await operation.call(
        Promise.resolve({ id: "not-a-uuid" }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_error" },
      });
      expect(from).not.toHaveBeenCalled();
    });
  }

  it("POST rejects extra fields before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    mockRequireRole.mockResolvedValue({
      supabase: { from },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await CREATE(
      request("/api/wine-list-items", "POST", {
        section_id: VALID_ID,
        wine_id: "33333333-3333-4333-8333-333333333333",
        restaurant_id: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("PATCH rejects negative prices before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    mockRequireRole.mockResolvedValue({
      supabase: { from },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await UPDATE(
      request(`/api/wine-list-items/${VALID_ID}`, "PATCH", {
        bottle_price: -1,
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("reorder rejects invalid and duplicate IDs before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    const rpc = vi.fn();
    mockRequireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    for (const orderedIds of [["not-a-uuid"], [VALID_ID, VALID_ID]]) {
      const response = await REORDER(
        request("/api/wine-list-items/reorder", "PATCH", { orderedIds }),
      );
      expect(response.status).toBe(400);
    }
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("wine-list item provider and write boundaries", () => {
  const restaurantId = "22222222-2222-4222-8222-222222222222";
  const sectionId = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => vi.clearAllMocks());

  function roleAuth(
    from: ReturnType<typeof vi.fn>,
    rpc: ReturnType<typeof vi.fn> = vi.fn(),
  ) {
    mockRequireRole.mockResolvedValue({
      supabase: { from, rpc },
      restaurantId,
      user: { id: "44444444-4444-4444-8444-444444444444" },
      role: "manager",
    });
  }

  function ownedItem() {
    return {
      id: VALID_ID,
      section_id: sectionId,
      wine_list_sections: {
        wine_lists: { restaurant_id: restaurantId },
      },
    };
  }

  it("redacts an unkeyed atomic-create provider failure", async () => {
    const from = vi.fn();
    const rpc = vi.fn(async () => ({
      data: null,
      error: new Error("provider secret"),
    }));
    roleAuth(from, rpc);

    const response = await CREATE(
      request("/api/wine-list-items", "POST", {
        section_id: sectionId,
        wine_id: "55555555-5555-4555-8555-555555555555",
      }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
    expect(JSON.stringify(body)).not.toContain("provider secret");
    expect(from).not.toHaveBeenCalled();
  });

  it("delegates unkeyed create to the atomic tenant-scoped RPC", async () => {
    const from = vi.fn();
    const rpc = vi.fn(async () => ({
      data: [{
        outcome: "created",
        response_status: 200,
        response_body: { id: VALID_ID },
        replayed: false,
      }],
      error: null,
    }));
    roleAuth(from, rpc);

    const response = await CREATE(
      request("/api/wine-list-items", "POST", {
        section_id: sectionId,
        wine_id: "55555555-5555-4555-8555-555555555555",
        glass_price: 14,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: VALID_ID });
    expect(rpc).toHaveBeenCalledWith(
      "create_wine_list_item_idempotent",
      {
        p_restaurant_id: restaurantId,
        p_section_id: sectionId,
        p_wine_id: "55555555-5555-4555-8555-555555555555",
        p_glass_price: 14,
      },
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("distinguishes an item lookup provider failure from missing", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: null,
      error: new Error("provider secret"),
    });
    roleAuth(vi.fn(() => lookup));

    const response = await UPDATE(
      request(`/api/wine-list-items/${VALID_ID}`, "PATCH", {
        glass_price: 14,
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  it("requires the section-scoped item update to affect a row", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: ownedItem(),
      error: null,
    });
    const update = queryEndingIn("maybeSingle", {
      data: null,
      error: null,
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(update);
    roleAuth(from);

    const response = await UPDATE(
      request(`/api/wine-list-items/${VALID_ID}`, "PATCH", {
        glass_price: 14,
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(404);
    expect(update.update).toHaveBeenCalledWith({ glass_price: 14 });
    expect(update.eq).toHaveBeenCalledWith("id", VALID_ID);
    expect(update.eq).toHaveBeenCalledWith("section_id", sectionId);
    expect(update.select).toHaveBeenCalledWith("id");
  });

  it("requires the section-scoped item delete to affect a row", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: ownedItem(),
      error: null,
    });
    const deletion = queryEndingIn("maybeSingle", {
      data: null,
      error: null,
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(deletion);
    roleAuth(from);

    const response = await REMOVE(
      request(`/api/wine-list-items/${VALID_ID}`, "DELETE"),
      {
      params: Promise.resolve({ id: VALID_ID }),
      },
    );

    expect(response.status).toBe(404);
    expect(deletion.delete).toHaveBeenCalledOnce();
    expect(deletion.eq).toHaveBeenCalledWith("id", VALID_ID);
    expect(deletion.eq).toHaveBeenCalledWith("section_id", sectionId);
  });

  it("rejects a reorder spanning two owned sections before the RPC", async () => {
    const secondId = "77777777-7777-4777-8777-777777777777";
    const lookup = queryEndingIn("in", {
      data: [
        ownedItem(),
        {
          ...ownedItem(),
          id: secondId,
          section_id: "88888888-8888-4888-8888-888888888888",
        },
      ],
      error: null,
    });
    const rpc = vi.fn();
    roleAuth(
      vi.fn(() => lookup),
      rpc,
    );

    const response = await REORDER(
      request("/api/wine-list-items/reorder", "PATCH", {
        orderedIds: [VALID_ID, secondId],
      }),
    );

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("redacts a reorder ownership-query provider failure", async () => {
    const lookup = queryEndingIn("in", {
      data: null,
      error: new Error("provider secret"),
    });
    const rpc = vi.fn();
    roleAuth(
      vi.fn(() => lookup),
      rpc,
    );

    const response = await REORDER(
      request("/api/wine-list-items/reorder", "PATCH", {
        orderedIds: [VALID_ID],
      }),
    );

    expect(response.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });
});
