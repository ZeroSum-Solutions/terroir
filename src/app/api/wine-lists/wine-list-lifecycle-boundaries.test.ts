import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

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
const { PATCH: UPDATE, DELETE: REMOVE } = await import("./[id]/route");
const { POST: CLONE } = await import("./[id]/clone/route");
const { GET: CSV } = await import("./[id]/csv/route");
const { POST: PUBLISH, DELETE: UNPUBLISH } = await import(
  "./[id]/publish/route"
);

const VALID_ID = "11111111-1111-4111-8111-111111111111";

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
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

describe("wine-list lifecycle API boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  const roleOperations = [
    {
      name: "PATCH list",
      call: (params: Promise<{ id: string }>) =>
        UPDATE(
          request(`/api/wine-lists/${VALID_ID}`, "PATCH", { name: "Dinner" }),
          { params },
        ),
    },
    {
      name: "DELETE list",
      call: (params: Promise<{ id: string }>) =>
        REMOVE({} as NextRequest, { params }),
    },
    {
      name: "POST clone",
      call: (params: Promise<{ id: string }>) =>
        CLONE({} as NextRequest, { params }),
    },
    {
      name: "POST publish",
      call: (params: Promise<{ id: string }>) =>
        PUBLISH(
          request(`/api/wine-lists/${VALID_ID}/publish`, "POST", {}),
          { params },
        ),
    },
    {
      name: "DELETE publish",
      call: (params: Promise<{ id: string }>) =>
        UNPUBLISH({} as NextRequest, { params }),
    },
  ];

  for (const operation of roleOperations) {
    it(`${operation.name} returns the exact role denial before resolving params`, async () => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      auth.requireRole.mockResolvedValue(denial);
      const watched = watchedParams();

      const response = await operation.call(watched.params);

      expect(response).toBe(denial);
      expect(watched.touches()).toBe(0);
    });

    it(`${operation.name} rejects an invalid UUID before database work`, async () => {
      const from = vi.fn(() => {
        throw new Error("database must not run");
      });
      auth.requireRole.mockResolvedValue({
        supabase: { from, rpc: vi.fn() },
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

  it("GET CSV returns the exact membership denial before resolving params", async () => {
    const denial = NextResponse.json(
      { error: { code: "unauthorized", message: "Unauthorized" } },
      { status: 401 },
    );
    auth.requireMembership.mockResolvedValue(denial);
    const watched = watchedParams();

    const response = await CSV({} as Request, { params: watched.params });

    expect(response).toBe(denial);
    expect(watched.touches()).toBe(0);
  });

  it("GET CSV rejects an invalid UUID before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    auth.requireMembership.mockResolvedValue({
      supabase: { from },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await CSV({} as Request, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("POST create rejects extra fields before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await CREATE(
      request("/api/wine-lists", "POST", {
        name: "Dinner",
        restaurant_id: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("POST publish rejects malformed JSON before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc: vi.fn() },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await PUBLISH(
      request(`/api/wine-lists/${VALID_ID}/publish`, "POST", "{bad json"),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});
