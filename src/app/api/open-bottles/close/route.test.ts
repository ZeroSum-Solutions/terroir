import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import {
  BOTTLE_ID,
  makeClients,
  REASON_ID,
  request,
  WINE_ID,
} from "./route.test-helpers";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockCreateClient = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: mockCaptureException }));

const { POST } = await import("./route");

function allow(auth: ReturnType<typeof makeClients>["auth"]) {
  mockRequireMembership.mockResolvedValue({
    supabase: auth,
    restaurantId: "r-A",
    user: { id: "u-close" },
    role: "staff",
  });
}

describe("POST /api/open-bottles/close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
  });

  it("returns the membership response before reading the body", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    expect((await POST(request({}))).status).toBe(401);
  });

  it("EV-10.2: returns stable 422 when a write-off omits its reason", async () => {
    const { auth, service } = makeClients();
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 570,
      written_off_ml: 30,
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "writeoff_reason_required",
        message: "A reason code is required for a write-off.",
      },
    });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("validates that exactly one bottle selector is present", async () => {
    const { auth, service } = makeClients();
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const missing = await POST(request({ actual_remaining_ml: 0 }));
    const duplicated = await POST(request({
      wine_id: WINE_ID,
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 0,
    }));

    expect(missing.status).toBe(400);
    expect(duplicated.status).toBe(400);
  });

  it("rejects physically impossible or overflowing close-out amounts", async () => {
    const { auth, service } = makeClients();
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const overBottle = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 751,
    }));
    const overBottleTotal = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 400,
      written_off_ml: 351,
      reason_code_id: REASON_ID,
    }));
    const overflow = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 2_147_483_648,
    }));

    expect(overBottle.status).toBe(422);
    expect((await overBottle.json()).error.code).toBe("invalid_closeout_amount");
    expect(overBottleTotal.status).toBe(422);
    expect(overflow.status).toBe(400);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("allows the full residual volume to be written off", async () => {
    const { auth, service } = makeClients();
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 0,
      written_off_ml: 750,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(201);
  });

  it("rejects a reason outside the restaurant or allowed categories", async () => {
    const { auth, service } = makeClients({
      reason: { id: REASON_ID, restaurant_id: "r-B", category: "breakage", active: true },
    });
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 570,
      written_off_ml: 30,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("invalid_writeoff_reason");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("fails closed when the requested bottle is outside the restaurant", async () => {
    const { auth, service } = makeClients({ bottle: null });
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 0,
    }));

    expect(response.status).toBe(404);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("EV-10.2: persists theoretical plus actual and reads generated variance back", async () => {
    const { auth, service, authCalls, serviceCalls } = makeClients();
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 570,
      written_off_ml: 30,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(201);
    expect((await response.json()).closeout).toMatchObject({
      theoretical_remaining_ml: 600,
      actual_remaining_ml: 570,
      variance_ml: -30,
    });
    expect(serviceCalls[0]).toEqual({
      table: "bottle_closeouts",
      method: "insert",
      payload: expect.objectContaining({
        restaurant_id: "r-A",
        wine_id: WINE_ID,
        open_bottle_id: BOTTLE_ID,
        theoretical_remaining_ml: 600,
        actual_remaining_ml: 570,
        written_off_ml: 30,
        reason_code_id: REASON_ID,
        preservation_method: "coravin",
        closed_by: "u-close",
      }),
    });
    expect(authCalls).toContainEqual({
      table: "pour_events",
      method: "eq",
      args: ["restaurant_id", "r-A"],
    });
    expect(authCalls).toContainEqual({
      table: "pour_events",
      method: "eq",
      args: ["open_bottle_id", BOTTLE_ID],
    });
    expect(authCalls).toContainEqual({
      table: "pour_events",
      method: "gte",
      args: ["occurred_at", "2026-08-18T17:00:00.000Z"],
    });
  });

  it("accepts wine_id and resolves the restaurant-scoped active bottle", async () => {
    const { auth, service, authCalls } = makeClients();
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      wine_id: WINE_ID,
      actual_remaining_ml: 570,
    }));

    expect(response.status).toBe(201);
    expect(authCalls).toContainEqual({
      table: "open_bottles",
      method: "eq",
      args: ["wine_id", WINE_ID],
    });
    expect(authCalls).toContainEqual({
      table: "open_bottles",
      method: "eq",
      args: ["restaurant_id", "r-A"],
    });
  });

  it("records finish_bottle against the selected bottle instead of inventing a second spill", async () => {
    const { auth, service, serviceCalls } = makeClients();
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 570,
      written_off_ml: 30,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(201);
    expect(serviceCalls[1]).toEqual({
      table: "pour_events",
      method: "insert",
      payload: {
        wine_id: WINE_ID,
        restaurant_id: "r-A",
        open_bottle_id: BOTTLE_ID,
        ml_delta: 500,
        kind: "finish_bottle",
        actor_user_id: "u-close",
        note: "Bottle close-out",
      },
    });
    expect(mockRevalidate).toHaveBeenCalledWith("/cellar");
    expect(mockRevalidate).toHaveBeenCalledWith("/insights");
  });

  it("surfaces the database write-off check as the same stable 422", async () => {
    const { auth, service } = makeClients({
      closeoutError: { code: "23514", message: "bottle_closeouts_writeoff_requires_reason" },
    });
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 570,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("writeoff_reason_required");
  });

  it("returns a sanitized 500 without exporting service-role provider errors", async () => {
    const { auth, service, serviceCalls } = makeClients({
      finishError: { code: "XX000", message: "service-role-secret" },
    });
    allow(auth);
    mockCreateClient.mockReturnValue(service);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 570,
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Failed to close bottle." },
    });
    expect(serviceCalls).toContainEqual({
      table: "bottle_closeouts",
      method: "delete",
      payload: null,
    });
    expect(serviceCalls).toContainEqual({
      table: "bottle_closeouts",
      method: "eq",
      payload: ["id", "closeout-1"],
    });
    expect(serviceCalls).toContainEqual({
      table: "bottle_closeouts",
      method: "eq",
      payload: ["restaurant_id", "r-A"],
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
