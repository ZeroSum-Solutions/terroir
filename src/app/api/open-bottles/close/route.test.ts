import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import {
  BOTTLE_ID,
  makeAuthenticatedClient,
  REASON_ID,
  request,
  WINE_ID,
} from "./route.test-helpers";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: mockCaptureException }));

const { POST } = await import("./route");

function allow(authenticatedClient: ReturnType<typeof makeAuthenticatedClient>["client"]) {
  mockRequireMembership.mockResolvedValue({
    supabase: authenticatedClient,
    restaurantId: "r-A",
    user: { id: "u-close" },
    role: "staff",
  });
}

describe("POST /api/open-bottles/close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the membership response before reading the body", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    expect((await POST(request({}))).status).toBe(401);
  });

  it("keeps shape validation and requires exactly one bottle selector", async () => {
    const { client, rpc } = makeAuthenticatedClient();
    allow(client);

    const missingSelector = await POST(request({ actual_remaining_ml: 0 }));
    const duplicateSelector = await POST(request({
      wine_id: WINE_ID,
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 0,
    }));
    const nonInteger = await POST(request({
      wine_id: WINE_ID,
      actual_remaining_ml: 1.5,
    }));

    expect(missingSelector.status).toBe(400);
    expect(duplicateSelector.status).toBe(400);
    expect(nonInteger.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("preserves open_bottle_id callers while using the authenticated RPC mutation", async () => {
    const { client, from, rpc } = makeAuthenticatedClient();
    allow(client);

    const response = await POST(request({
      open_bottle_id: BOTTLE_ID,
      actual_remaining_ml: 570,
    }));

    expect(response.status).toBe(201);
    expect(from).toHaveBeenCalledWith("open_bottles");
    expect(rpc).toHaveBeenCalledWith("close_open_bottle", expect.objectContaining({
      p_wine_id: WINE_ID,
    }));
  });

  it("EV-10.2: returns stable 422 before the RPC when a write-off omits its reason", async () => {
    const { client, rpc } = makeAuthenticatedClient();
    allow(client);

    const response = await POST(request({
      wine_id: WINE_ID,
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
    expect(rpc).not.toHaveBeenCalled();
  });

  it("closes atomically through the authenticated RPC and returns its closeout", async () => {
    const { client, rpc, closeout } = makeAuthenticatedClient();
    allow(client);

    const response = await POST(request({
      wine_id: WINE_ID,
      actual_remaining_ml: 570,
      written_off_ml: 30,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ closeout });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("close_open_bottle", {
      p_wine_id: WINE_ID,
      p_actual_remaining_ml: 570,
      p_written_off_ml: 30,
      p_reason_code_id: REASON_ID,
    });
    expect(mockRevalidate).toHaveBeenCalledWith("/cellar");
    expect(mockRevalidate).toHaveBeenCalledWith("/insights");
  });

  it.each([
    ["open_bottle_not_found", 404, "open_bottle_not_found"],
    ["writeoff_reason_required", 422, "writeoff_reason_required"],
    ["invalid_reason_code", 422, "invalid_reason_code"],
    ["invalid_writeoff_amount", 422, "invalid_writeoff_amount"],
    ["invalid_actual_remaining", 422, "invalid_actual_remaining"],
    ["forbidden", 403, "forbidden"],
  ])("maps RPC error %s to HTTP %i with stable code %s", async (message, status, code) => {
    const { client } = makeAuthenticatedClient({ rpcError: { message } });
    allow(client);

    const response = await POST(request({
      wine_id: WINE_ID,
      actual_remaining_ml: 570,
      written_off_ml: message === "invalid_writeoff_amount" ? 571 : 0,
      reason_code_id: message === "invalid_writeoff_amount" ? REASON_ID : undefined,
    }));

    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it("returns 422 when the write-off exceeds the actual remainder", async () => {
    const { client, rpc } = makeAuthenticatedClient({
      rpcError: { message: "invalid_writeoff_amount" },
    });
    allow(client);

    const response = await POST(request({
      wine_id: WINE_ID,
      actual_remaining_ml: 200,
      written_off_ml: 201,
      reason_code_id: REASON_ID,
    }));

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("invalid_writeoff_amount");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("sanitizes unknown RPC errors", async () => {
    const { client } = makeAuthenticatedClient({
      rpcError: { code: "XX000", message: "provider-secret" },
    });
    allow(client);

    const response = await POST(request({
      wine_id: WINE_ID,
      actual_remaining_ml: 570,
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Failed to close bottle." },
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
