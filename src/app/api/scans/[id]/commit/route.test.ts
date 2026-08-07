import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST } = await import("./route");

const SCAN_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const WINE_ID = "33333333-3333-4333-8333-333333333333";

function commitBody() {
  return { scanId: SCAN_ID, itemCount: 1, wineCount: 1 };
}

function commitResult(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "committed",
    response_status: 200,
    response_body: commitBody(),
    replayed: false,
    wine_ids: [WINE_ID],
    ...overrides,
  };
}

function makeSupabase(options: {
  commitData?: unknown;
  commitError?: unknown;
  lwin?: "reject" | "throw" | "ok";
} = {}) {
  const rpc = vi.fn((name: string) => {
    if (name === "commit_reviewed_invoice_scan_idempotent") {
      return Promise.resolve({
        data:
          options.commitData === undefined
            ? [commitResult()]
            : options.commitData,
        error: options.commitError ?? null,
      });
    }
    if (options.lwin === "throw") {
      throw new Error("LWIN sync failure");
    }
    if (options.lwin === "reject") {
      return Promise.reject(new Error("LWIN reject"));
    }
    return Promise.resolve({ data: null, error: null });
  });
  return { supabase: { rpc }, rpc };
}

function authorize(supabase: unknown) {
  auth.requireMembership.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: "44444444-4444-4444-8444-444444444444" },
    role: "staff",
  });
}

function call(key?: string, reviewed?: boolean, reviewHeader?: string) {
  const headers = new Headers();
  if (key) headers.set("Idempotency-Key", key);
  if (reviewed !== undefined) {
    headers.set("X-Low-Confidence-Reviewed", String(reviewed));
  } else if (reviewHeader !== undefined) {
    headers.set("X-Low-Confidence-Reviewed", reviewHeader);
  }
  return POST(
    new Request(`http://localhost/api/scans/${SCAN_ID}/commit`, {
      method: "POST",
      headers,
    }) as NextRequest,
    { params: Promise.resolve({ id: SCAN_ID }) },
  );
}

describe("POST /api/scans/[id]/commit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves keyless behavior through the atomic RPC", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(commitBody());
    expect(db.rpc).toHaveBeenNthCalledWith(
      1,
      "commit_reviewed_invoice_scan_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_scan_id: SCAN_ID,
        p_low_confidence_reviewed: false,
      },
    );
  });

  it("binds a valid key to the canonical validated scan identity", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await call("scan_commit_key_0001");

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(db.rpc).toHaveBeenNthCalledWith(
      1,
      "commit_reviewed_invoice_scan_idempotent",
      {
        p_restaurant_id: RESTAURANT_ID,
        p_scan_id: SCAN_ID,
        p_low_confidence_reviewed: false,
        p_idempotency_key: "scan_commit_key_0001",
        p_request_hash: createIdempotencyRequestHash({ id: SCAN_ID }),
      },
    );
  });

  it("rejects malformed keys before any database command", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await call("bad key!");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_idempotency_key",
        message: "Invalid Idempotency-Key.",
      },
    });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("forwards an explicit low-confidence review confirmation", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await call("scan_commit_reviewed_0001", true);

    expect(response.status).toBe(200);
    expect(db.rpc).toHaveBeenNthCalledWith(
      1,
      "commit_reviewed_invoice_scan_idempotent",
      expect.objectContaining({ p_low_confidence_reviewed: true }),
    );
  });

  it("rejects a malformed low-confidence review header before database work", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await call(undefined, undefined, "yes");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_review_confirmation" },
    });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a missing scan",
      commitResult({
        outcome: "not_found",
        response_status: 404,
        response_body: {
          error: { code: "not_found", message: "Scan not found." },
        },
        wine_ids: null,
      }),
      404,
    ],
    [
      "invalid persisted line items",
      commitResult({
        outcome: "invalid_scan",
        response_status: 400,
        response_body: {
          error: {
            code: "bad_request",
            message: "Scan has no valid line items to commit.",
          },
        },
        wine_ids: null,
      }),
      400,
    ],
    [
      "an unreviewed low-confidence scan",
      commitResult({
        outcome: "review_required",
        response_status: 422,
        response_body: {
          error: {
            code: "low_confidence_review_required",
            message: "Review low-confidence scan fields before committing.",
          },
        },
        wine_ids: null,
      }),
      422,
    ],
  ])("returns the stored result for %s", async (_name, result, status) => {
    const db = makeSupabase({ commitData: [result] });
    authorize(db.supabase);

    const response = await call("scan_commit_key_0002");

    expect(response.status).toBe(status);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it("replays the exact committed body without repeating LWIN work", async () => {
    const db = makeSupabase({
      commitData: [
        commitResult({
          outcome: "replay",
          replayed: true,
          wine_ids: null,
        }),
      ],
    });
    authorize(db.supabase);

    const response = await call("scan_commit_key_0003");

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(commitBody());
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      404,
      { error: { code: "not_found", message: "Scan not found." } },
    ],
    [
      400,
      {
        error: {
          code: "bad_request",
          message: "Scan has no valid line items to commit.",
        },
      },
    ],
  ])(
    "replays an exact stored %s response instead of wedging the command",
    async (status, responseBody) => {
      const db = makeSupabase({
        commitData: [
          commitResult({
            outcome: "replay",
            response_status: status,
            response_body: responseBody,
            replayed: true,
            wine_ids: null,
          }),
        ],
      });
      authorize(db.supabase);

      const response = await call("scan_commit_error_replay_0001");

      expect(response.status).toBe(status);
      expect(response.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await response.json()).toEqual(responseBody);
      expect(db.rpc).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["throw", "reject"] as const)(
    "keeps atomic inventory success successful when LWIN enrichment %ss",
    async (lwin) => {
      const db = makeSupabase({ lwin });
      authorize(db.supabase);

      const response = await call();

      expect(response.status).toBe(200);
      expect(db.rpc).toHaveBeenNthCalledWith(2, "match_lwin_batch", {
        p_restaurant_id: RESTAURANT_ID,
        p_wine_ids: [WINE_ID],
      });
    },
  );

  it("fails keyed malformed RPC results closed", async () => {
    const db = makeSupabase({
      commitData: [commitResult({ wine_ids: ["not-a-uuid"] })],
    });
    authorize(db.supabase);

    const response = await call("scan_commit_key_0004");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    });
  });

  it("fails keyless malformed RPC results as an internal error", async () => {
    const db = makeSupabase({
      commitData: [commitResult({ wine_ids: ["not-a-uuid"] })],
    });
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });

  it("maps database authorization failures without leaking details", async () => {
    const db = makeSupabase({
      commitError: {
        code: "42501",
        message: "sensitive membership detail",
      },
    });
    authorize(db.supabase);

    const response = await call("scan_commit_key_0005");

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive");
  });

  it("marks an in-progress command retryable", async () => {
    const db = makeSupabase({
      commitData: [
        commitResult({
          outcome: "idempotency_in_progress",
          response_status: 409,
          response_body: {
            error: {
              code: "idempotency_in_progress",
              message: "An identical request is still in progress.",
            },
          },
          wine_ids: null,
        }),
      ],
    });
    authorize(db.supabase);

    const response = await call("scan_commit_key_0006");

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("redacts atomic RPC failures", async () => {
    const db = makeSupabase({
      commitError: {
        code: "XX000",
        message: "sensitive database detail",
      },
    });
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive");
  });
});
