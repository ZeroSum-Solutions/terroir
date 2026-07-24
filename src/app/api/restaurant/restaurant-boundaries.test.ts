import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const auth = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireOwner: vi.fn(),
}));
vi.mock("@/lib/api/auth", () => ({
  requireAuth: (...args: unknown[]) => auth.requireAuth(...args),
  requireOwner: (...args: unknown[]) => auth.requireOwner(...args),
}));

const active = vi.hoisted(() => ({ setActiveRestaurant: vi.fn() }));
vi.mock("@/lib/api/active-restaurant", () => ({
  setActiveRestaurant: (...args: unknown[]) =>
    active.setActiveRestaurant(...args),
}));

const { GET, PUT, PATCH, DELETE } = await import("./[id]/route");

const VALID_ID = "11111111-1111-4111-8111-111111111111";

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

const patchRequest = new Request(`http://localhost/api/restaurant/${VALID_ID}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: "{\"name\":\"Bistro\"}",
}) as NextRequest;

describe("restaurant API boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  const operations = [
    {
      name: "GET",
      auth: "requireAuth" as const,
      call: (params: Promise<{ id: string }>) =>
        GET({} as NextRequest, { params }),
    },
    {
      name: "PUT",
      auth: "requireAuth" as const,
      call: (params: Promise<{ id: string }>) =>
        PUT({} as NextRequest, { params }),
    },
    {
      name: "PATCH",
      auth: "requireOwner" as const,
      call: (params: Promise<{ id: string }>) =>
        PATCH(patchRequest, { params }),
    },
    {
      name: "DELETE",
      auth: "requireOwner" as const,
      call: (params: Promise<{ id: string }>) =>
        DELETE({} as NextRequest, { params }),
    },
  ];

  for (const operation of operations) {
    it(`${operation.name} returns the exact auth denial before resolving params`, async () => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      auth[operation.auth].mockResolvedValue(denial);
      const watched = watchedParams();

      const response = await operation.call(watched.params);

      expect(response).toBe(denial);
      expect(watched.touches()).toBe(0);
    });

    it(`${operation.name} rejects an invalid restaurant UUID before dependencies`, async () => {
      const from = vi.fn(() => {
        throw new Error("database must not run");
      });
      auth[operation.auth].mockResolvedValue({
        supabase: { from },
        user: { id: "22222222-2222-4222-8222-222222222222" },
        restaurantId: VALID_ID,
        role: "owner",
      });

      const response = await operation.call(
        Promise.resolve({ id: "not-a-uuid" }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_error" },
      });
      expect(from).not.toHaveBeenCalled();
      expect(active.setActiveRestaurant).not.toHaveBeenCalled();
    });
  }
});
