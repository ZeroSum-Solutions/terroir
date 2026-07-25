import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
const mockRevalidate = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidate(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { POST } = await import("./route");

type RpcCall = { fn: string; args: unknown };

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const BOTTLE_ID = "b1b2c3d4-e5f6-4789-8abc-def012345678";
const RESTAURANT_ID = "c1b2c3d4-e5f6-4789-8abc-def012345678";
const KEY = "d1b2c3d4-e5f6-4789-8abc-def012345678";
const STARTED_AT = "2026-07-24T17:00:00.000Z";
const OPEN_BOTTLE = {
  id: BOTTLE_ID,
  wine_id: WINE_ID,
  restaurant_id: RESTAURANT_ID,
  remaining_ml: 602,
  opened_at: "2026-07-24T16:59:59.000Z",
  opened_by: "user-a",
  source_inventory_item_id: null,
  closed_at: null,
};

function pourResult(
  overrides: Partial<{
    outcome: string;
    response_status: number;
    response_body: unknown;
    replayed: boolean;
    execution_started_at: string;
  }> = {},
) {
  return {
    outcome: "poured",
    response_status: 200,
    response_body: { open_bottle: OPEN_BOTTLE },
    replayed: false,
    execution_started_at: STARTED_AT,
    ...overrides,
  };
}

function makeSupabase(opts: {
  recordPour: { data?: unknown; error?: unknown };
  autoEightysixedWineIds?: string[];
  publishedSlugs?: Array<{ slug: string }>;
}) {
  const calls: RpcCall[] = [];
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.push({ fn, args });
    if (fn === "record_pour_idempotent") {
      return Promise.resolve({
        data: opts.recordPour.data ?? null,
        error: opts.recordPour.error ?? null,
      });
    }
    if (fn === "wine_published_list_slugs") {
      return Promise.resolve({
        data: opts.publishedSlugs ?? [],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const from = vi.fn((table: string) => {
    const thenable = {
      select: () => thenable,
      eq: () => thenable,
      is: () => thenable,
      gte: () => thenable,
      in: () => thenable,
      then: (resolve: (value: unknown) => void) => {
        resolve({
          data:
            table === "availability_events"
              ? (opts.autoEightysixedWineIds ?? []).map((wine_id) => ({
                  wine_id,
                }))
              : null,
          error: null,
        });
      },
    };
    return thenable;
  });
  return { supabase: { rpc, from }, calls };
}

function makeRequest(
  body: unknown,
  key?: string,
): NextRequest {
  return new Request("http://localhost/api/pour", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function allow(supabase: ReturnType<typeof makeSupabase>["supabase"]) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("POST /api/pour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves auth-first behavior", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid bodies before the RPC", async () => {
    const { supabase } = makeSupabase({ recordPour: {} });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: "five ounces" }),
    );

    expect(response.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects a malformed supplied idempotency key before the RPC", async () => {
    const { supabase } = makeSupabase({ recordPour: {} });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }, "bad key"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("keeps missing-key compatibility on the dedicated transaction", async () => {
    const { supabase } = makeSupabase({
      recordPour: { data: [pourResult()] },
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      open_bottle: OPEN_BOTTLE,
    });
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "record_pour_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_id: WINE_ID,
        p_ml: 148,
        p_kind: "pour",
        p_note: null,
      },
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/availability");
  });

  it("binds every normalized body field to a keyed pour", async () => {
    const { supabase } = makeSupabase({
      recordPour: { data: [pourResult()] },
    });
    allow(supabase);

    const response = await POST(
      makeRequest(
        {
          wine_id: WINE_ID,
          ml: 90,
          kind: "spill",
          note: "  tasting spill  ",
        },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(supabase.rpc).toHaveBeenCalledWith(
      "record_pour_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_id: WINE_ID,
        p_ml: 90,
        p_kind: "spill",
        p_note: "tasting spill",
        p_idempotency_key: KEY,
        p_request_hash:
          "44789e23c02485aabbfb55c1b0dda9cdce2cac4cd6c98db257b2bf9ffc389f80",
      },
    );
  });

  it("normalizes an empty optional note to null", async () => {
    const { supabase } = makeSupabase({
      recordPour: { data: [pourResult()] },
    });
    allow(supabase);

    await POST(
      makeRequest(
        { wine_id: WINE_ID, ml: 148, note: "   " },
        KEY,
      ),
    );

    expect(supabase.rpc).toHaveBeenCalledWith(
      "record_pour_idempotent",
      expect.objectContaining({ p_note: null }),
    );
  });

  it("normalizes uppercase UUID input before hashing and mutation", async () => {
    const { supabase } = makeSupabase({
      recordPour: { data: [pourResult()] },
    });
    allow(supabase);

    const response = await POST(
      makeRequest(
        { wine_id: WINE_ID.toUpperCase(), ml: 148 },
        KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "record_pour_idempotent",
      expect.objectContaining({
        p_wine_id: WINE_ID,
        p_request_hash:
          "f248332dcde6453002b0d15f3db6b5ce5b94c7755bcd03970bb0bd117ba9b678",
      }),
    );
  });

  it("replays the exact stored response and original revalidation window", async () => {
    const { supabase } = makeSupabase({
      recordPour: {
        data: [
          pourResult({
            outcome: "replay",
            replayed: true,
          }),
        ],
      },
      autoEightysixedWineIds: [WINE_ID],
      publishedSlugs: [{ slug: "by-the-glass" }],
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }, KEY),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(response.json()).resolves.toEqual({
      open_bottle: OPEN_BOTTLE,
    });
    expect(mockRevalidate).toHaveBeenCalledWith("/availability");
    expect(mockRevalidate).toHaveBeenCalledWith("/list/by-the-glass");
  });

  it.each([
    [
      "no_inventory",
      409,
      {
        error: {
          code: "no_inventory",
          message: "No inventory available.",
        },
      },
    ],
    [
      "not_found",
      404,
      { error: { code: "not_found", message: "Wine not found." } },
    ],
  ] as const)(
    "returns and marks the stored %s response",
    async (outcome, status, responseBody) => {
      const { supabase } = makeSupabase({
        recordPour: {
          data: [
            pourResult({
              outcome,
              response_status: status,
              response_body: responseBody,
            }),
          ],
        },
      });
      allow(supabase);

      const response = await POST(
        makeRequest({ wine_id: WINE_ID, ml: 148 }, KEY),
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("Idempotency-Replayed")).toBe("false");
      await expect(response.json()).resolves.toEqual(responseBody);
      expect(mockRevalidate).not.toHaveBeenCalled();
    },
  );

  it("returns the exact in-progress envelope and retry hint", async () => {
    const body = {
      error: {
        code: "idempotency_in_progress",
        message:
          "A request with this Idempotency-Key is still in progress.",
      },
    };
    const { supabase } = makeSupabase({
      recordPour: {
        data: [
          pourResult({
            outcome: "idempotency_in_progress",
            response_status: 409,
            response_body: body,
          }),
        ],
      },
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }, KEY),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    await expect(response.json()).resolves.toEqual(body);
  });

  it("preserves a permission failure as 403", async () => {
    const { supabase } = makeSupabase({
      recordPour: {
        error: { code: "42501", message: "forbidden" },
      },
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }, KEY),
    );

    expect(response.status).toBe(403);
  });

  it("fails an unknown keyed RPC error closed", async () => {
    const providerError = {
      code: "XX000",
      message: "induced completion failure",
    };
    const { supabase } = makeSupabase({
      recordPour: { error: providerError },
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }, KEY),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(providerError, {
      tags: { surface: "pour", phase: "idempotent-rpc" },
    });
  });

  it("treats a keyed database validation failure as terminal", async () => {
    const providerError = {
      code: "22023",
      message: "request hash does not match the canonical pour identity",
    };
    const { supabase } = makeSupabase({
      recordPour: { error: providerError },
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }, KEY),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_pour_request",
        message: "Invalid pour request.",
      },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(providerError, {
      tags: { surface: "pour", phase: "idempotent-rpc" },
    });
  });

  it("preserves the exact keyless unknown-error envelope", async () => {
    const providerError = {
      code: "XX000",
      message: "provider details",
    };
    const { supabase } = makeSupabase({
      recordPour: { error: providerError },
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Pour failed." },
    });
  });

  it("fails a malformed keyed RPC result closed", async () => {
    const { supabase } = makeSupabase({
      recordPour: {
        data: [pourResult({ response_body: null })],
      },
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }, KEY),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      {
        tags: {
          surface: "pour",
          phase: "idempotent-rpc-result",
        },
      },
    );
  });

  it("fails an outcome/status mismatch closed", async () => {
    const { supabase } = makeSupabase({
      recordPour: {
        data: [pourResult({ outcome: "no_inventory" })],
      },
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }, KEY),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "idempotency_unavailable" },
    });
  });

  it("does not query list slugs when the pour did not auto-86", async () => {
    const { supabase, calls } = makeSupabase({
      recordPour: { data: [pourResult()] },
      autoEightysixedWineIds: [],
    });
    allow(supabase);

    await POST(makeRequest({ wine_id: WINE_ID, ml: 148 }));

    expect(
      calls.some((call) => call.fn === "wine_published_list_slugs"),
    ).toBe(false);
    expect(
      mockRevalidate.mock.calls.some(([path]) =>
        String(path).startsWith("/list/"),
      ),
    ).toBe(false);
  });

  it("revalidates published lists for an unkeyed auto-86 pour", async () => {
    const { supabase } = makeSupabase({
      recordPour: { data: [pourResult()] },
      autoEightysixedWineIds: [WINE_ID],
      publishedSlugs: [{ slug: "dinner" }, { slug: "by-the-glass" }],
    });
    allow(supabase);

    const response = await POST(
      makeRequest({ wine_id: WINE_ID, ml: 148 }),
    );

    expect(response.status).toBe(200);
    expect(mockRevalidate).toHaveBeenCalledWith("/list/dinner");
    expect(mockRevalidate).toHaveBeenCalledWith("/list/by-the-glass");
  });
});
