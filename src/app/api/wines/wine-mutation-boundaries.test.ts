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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { PATCH: UPDATE_WINE } = await import("./[id]/route");
const { PATCH: AVAILABILITY } = await import("./[id]/availability/route");
const { POST: DISMISS } = await import(
  "./[id]/dismiss-pricing-alert/route"
);
const { POST: OVERPAID } = await import("./[id]/overpaid/route");
const { PATCH: TARGETS } = await import("./[id]/pricing-targets/route");
const { POST: SNOOZE } = await import("./[id]/snooze-alert/route");

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

const operations = [
  {
    name: "PATCH wine",
    auth: "role",
    call: (params: Promise<{ id: string }>) =>
      UPDATE_WINE(
        request(`/api/wines/${VALID_ID}`, "PATCH", { name: "Reserve" }),
        { params },
      ),
  },
  {
    name: "PATCH availability",
    auth: "role",
    call: (params: Promise<{ id: string }>) =>
      AVAILABILITY(
        request(`/api/wines/${VALID_ID}/availability`, "PATCH", {
          direction: "restored",
        }),
        { params },
      ),
  },
  {
    name: "POST dismiss pricing",
    auth: "membership",
    call: (params: Promise<{ id: string }>) =>
      DISMISS(
        request(`/api/wines/${VALID_ID}/dismiss-pricing-alert`, "POST", {}),
        { params },
      ),
  },
  {
    name: "POST overpaid",
    auth: "membership",
    call: (params: Promise<{ id: string }>) =>
      OVERPAID(request(`/api/wines/${VALID_ID}/overpaid`, "POST"), {
        params,
      }),
  },
  {
    name: "PATCH pricing targets",
    auth: "membership",
    call: (params: Promise<{ id: string }>) =>
      TARGETS(
        request(`/api/wines/${VALID_ID}/pricing-targets`, "PATCH", {
          markup_ratio: 2,
        }),
        { params },
      ),
  },
  {
    name: "POST snooze alert",
    auth: "membership",
    call: (params: Promise<{ id: string }>) =>
      SNOOZE(
        request(`/api/wines/${VALID_ID}/snooze-alert`, "POST", {}),
        { params },
      ),
  },
] as const;

describe("wine mutation request boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const operation of operations) {
    it(`${operation.name} returns auth denial before resolving params`, async () => {
      const denial = NextResponse.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 },
      );
      if (operation.auth === "role") {
        auth.requireRole.mockResolvedValue(denial);
      } else {
        auth.requireMembership.mockResolvedValue(denial);
      }
      const watched = watchedParams();

      const response = await operation.call(watched.params);

      expect(response).toBe(denial);
      expect(watched.touches()).toBe(0);
    });

    it(`${operation.name} rejects an invalid UUID before database work`, async () => {
      const from = vi.fn(() => {
        throw new Error("database must not run");
      });
      const allowed = {
        supabase: { from, rpc: vi.fn() },
        restaurantId: "22222222-2222-4222-8222-222222222222",
        role: "owner",
      };
      if (operation.auth === "role") {
        auth.requireRole.mockResolvedValue(allowed);
      } else {
        auth.requireMembership.mockResolvedValue(allowed);
      }

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

  it("PATCH wine rejects unknown fields before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc: vi.fn() },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await UPDATE_WINE(
      request(`/api/wines/${VALID_ID}`, "PATCH", {
        name: "Reserve",
        restaurant_id: "attacker-controlled",
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("PATCH availability rejects unknown fields before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    auth.requireRole.mockResolvedValue({
      supabase: { from, rpc: vi.fn() },
      restaurantId: "22222222-2222-4222-8222-222222222222",
    });

    const response = await AVAILABILITY(
      request(`/api/wines/${VALID_ID}/availability`, "PATCH", {
        direction: "restored",
        restaurant_id: "attacker-controlled",
      }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  for (const operation of [
    {
      name: "dismiss pricing",
      call: (requestValue: NextRequest) =>
        DISMISS(requestValue, {
          params: Promise.resolve({ id: VALID_ID }),
        }),
    },
    {
      name: "snooze alert",
      call: (requestValue: NextRequest) =>
        SNOOZE(requestValue, {
          params: Promise.resolve({ id: VALID_ID }),
        }),
    },
  ]) {
    it(`POST ${operation.name} rejects malformed JSON before database work`, async () => {
      const from = vi.fn(() => {
        throw new Error("database must not run");
      });
      auth.requireMembership.mockResolvedValue({
        supabase: { from, rpc: vi.fn() },
        restaurantId: "22222222-2222-4222-8222-222222222222",
        role: "owner",
      });

      const response = await operation.call(
        request(`/api/wines/${VALID_ID}`, "POST", "{bad json"),
      );

      expect(response.status).toBe(400);
      expect(from).not.toHaveBeenCalled();
    });
  }
});
