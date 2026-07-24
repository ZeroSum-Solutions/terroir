import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mocks.requireRole(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST: CREATE } = await import("./route");
const { PATCH: RENAME, DELETE: REMOVE } = await import("./[id]/route");
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
  terminal: "maybeSingle" | "single",
  result: QueryResult,
) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "in", "insert", "update", "delete"]) {
    query[method] = vi.fn(() => query);
  }
  query[terminal] = vi.fn(async () => result);
  return query;
}

describe("wine-list section API boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const operation of [
    {
      name: "PATCH section",
      call: (params: Promise<{ id: string }>) =>
        RENAME(
          request(`/api/wine-list-sections/${VALID_ID}`, "PATCH", {
            name: "Reds",
          }),
          { params },
        ),
    },
    {
      name: "DELETE section",
      call: (params: Promise<{ id: string }>) =>
        REMOVE({} as NextRequest, { params }),
    },
  ]) {
    it(`${operation.name} returns the exact auth denial before resolving params`, async () => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      mocks.requireRole.mockResolvedValue(denial);
      const watched = watchedParams();

      const response = await operation.call(watched.params);

      expect(response).toBe(denial);
      expect(watched.touches()).toBe(0);
    });

    it(`${operation.name} rejects an invalid UUID before dependencies`, async () => {
      const from = vi.fn();
      mocks.requireRole.mockResolvedValue({
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
    const from = vi.fn();
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await CREATE(
      request("/api/wine-list-sections", "POST", {
        wine_list_id: VALID_ID,
        name: "Reds",
        restaurant_id: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("reorder rejects invalid and duplicate IDs before dependencies", async () => {
    const from = vi.fn();
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });
    for (const orderedIds of [["not-a-uuid"], [VALID_ID, VALID_ID]]) {
      const response = await REORDER(
        request("/api/wine-list-sections/reorder", "PATCH", { orderedIds }),
      );
      expect(response.status).toBe(400);
    }
    expect(from).not.toHaveBeenCalled();
  });
});

describe("wine-list section provider and write boundaries", () => {
  const restaurantId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => vi.clearAllMocks());

  function roleAuth(from: ReturnType<typeof vi.fn>) {
    mocks.requireRole.mockResolvedValue({
      supabase: { from },
      restaurantId,
      user: { id: "33333333-3333-4333-8333-333333333333" },
      role: "manager",
    });
  }

  it("redacts a create owner-lookup provider failure", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: null,
      error: new Error("provider secret"),
    });
    roleAuth(vi.fn(() => lookup));

    const response = await CREATE(
      request("/api/wine-list-sections", "POST", {
        wine_list_id: VALID_ID,
        name: "Reds",
      }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
    expect(JSON.stringify(body)).not.toContain("provider secret");
  });

  it("distinguishes a section lookup provider failure from a missing section", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: null,
      error: new Error("provider secret"),
    });
    roleAuth(vi.fn(() => lookup));

    const response = await RENAME(
      request(`/api/wine-list-sections/${VALID_ID}`, "PATCH", {
        name: "Reds",
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  it("returns an opaque 404 for a foreign section without attempting a write", async () => {
    const lookup = queryEndingIn("maybeSingle", {
      data: {
        id: VALID_ID,
        wine_list_id: "44444444-4444-4444-8444-444444444444",
        wine_lists: {
          restaurant_id: "55555555-5555-4555-8555-555555555555",
        },
      },
      error: null,
    });
    const from = vi.fn(() => lookup);
    roleAuth(from);

    const response = await REMOVE({} as NextRequest, {
      params: Promise.resolve({ id: VALID_ID }),
    });

    expect(response.status).toBe(404);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("requires the parent-scoped rename to affect a row", async () => {
    const wineListId = "44444444-4444-4444-8444-444444444444";
    const lookup = queryEndingIn("maybeSingle", {
      data: {
        id: VALID_ID,
        wine_list_id: wineListId,
        wine_lists: { restaurant_id: restaurantId },
      },
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

    const response = await RENAME(
      request(`/api/wine-list-sections/${VALID_ID}`, "PATCH", {
        name: "Reds",
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(404);
    expect(update.update).toHaveBeenCalledWith({ name: "Reds" });
    expect(update.eq).toHaveBeenCalledWith("id", VALID_ID);
    expect(update.eq).toHaveBeenCalledWith("wine_list_id", wineListId);
    expect(update.select).toHaveBeenCalledWith("id");
  });

  it("requires the parent-scoped delete to affect a row", async () => {
    const wineListId = "44444444-4444-4444-8444-444444444444";
    const lookup = queryEndingIn("maybeSingle", {
      data: {
        id: VALID_ID,
        wine_list_id: wineListId,
        wine_lists: { restaurant_id: restaurantId },
      },
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

    const response = await REMOVE({} as NextRequest, {
      params: Promise.resolve({ id: VALID_ID }),
    });

    expect(response.status).toBe(404);
    expect(deletion.delete).toHaveBeenCalledOnce();
    expect(deletion.eq).toHaveBeenCalledWith("id", VALID_ID);
    expect(deletion.eq).toHaveBeenCalledWith("wine_list_id", wineListId);
  });

  it("rejects a reorder spanning two owned wine lists before writes", async () => {
    const secondId = "66666666-6666-4666-8666-666666666666";
    const lookup = queryEndingIn("single", { data: null, error: null });
    lookup.in = vi.fn(async () => ({
      data: [
        {
          id: VALID_ID,
          wine_list_id: "44444444-4444-4444-8444-444444444444",
          wine_lists: { restaurant_id: restaurantId },
        },
        {
          id: secondId,
          wine_list_id: "77777777-7777-4777-8777-777777777777",
          wine_lists: { restaurant_id: restaurantId },
        },
      ],
      error: null,
    }));
    const from = vi.fn(() => lookup);
    roleAuth(from);

    const response = await REORDER(
      request("/api/wine-list-sections/reorder", "PATCH", {
        orderedIds: [VALID_ID, secondId],
      }),
    );

    expect(response.status).toBe(400);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("checks every reordered write result and scopes it to the parent list", async () => {
    const secondId = "66666666-6666-4666-8666-666666666666";
    const wineListId = "44444444-4444-4444-8444-444444444444";
    const lookup = queryEndingIn("single", { data: null, error: null });
    lookup.in = vi.fn(async () => ({
      data: [
        {
          id: VALID_ID,
          wine_list_id: wineListId,
          wine_lists: { restaurant_id: restaurantId },
        },
        {
          id: secondId,
          wine_list_id: wineListId,
          wine_lists: { restaurant_id: restaurantId },
        },
      ],
      error: null,
    }));
    const firstUpdate = queryEndingIn("maybeSingle", {
      data: { id: VALID_ID },
      error: null,
    });
    const secondUpdate = queryEndingIn("maybeSingle", {
      data: null,
      error: null,
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(firstUpdate)
      .mockReturnValueOnce(secondUpdate);
    roleAuth(from);

    const response = await REORDER(
      request("/api/wine-list-sections/reorder", "PATCH", {
        orderedIds: [VALID_ID, secondId],
      }),
    );

    expect(response.status).toBe(404);
    expect(firstUpdate.update).toHaveBeenCalledWith({ position: 0 });
    expect(secondUpdate.update).toHaveBeenCalledWith({ position: 1 });
    for (const update of [firstUpdate, secondUpdate]) {
      expect(update.eq).toHaveBeenCalledWith("wine_list_id", wineListId);
      expect(update.select).toHaveBeenCalledWith("id");
    }
  });
});
