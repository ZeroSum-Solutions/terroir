import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockApplyImportBatchChunk = vi.fn();
const mockFindSiblingWithAppliedRows = vi.fn();
vi.mock("@/domains/import/batch-service", () => ({
  applyImportBatchChunk: (...args: unknown[]) => mockApplyImportBatchChunk(...args),
  findSiblingWithAppliedRows: (...args: unknown[]) => mockFindSiblingWithAppliedRows(...args),
}));

const { POST } = await import("./route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";

function request() {
  return new Request(`http://localhost/api/import/batches/${BATCH_ID}/apply`, { method: "POST" }) as unknown as NextRequest;
}
function params() {
  return Promise.resolve({ id: BATCH_ID });
}

/**
 * `preApply` backs the pre-apply `id, content_sha256` read; `postApply`
 * (defaulting to the same value as `preApply` when omitted — the ordinary
 * "nothing changed mid-request" case) backs the WARN-4 post-apply `status`
 * re-read. A null `preApply` simulates the batch not existing/not this
 * tenant's (404).
 */
function makeSupabase(preApply: unknown, postApply: unknown = preApply) {
  let call = 0;
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => {
            call += 1;
            return { data: call === 1 ? preApply : postApply, error: null };
          },
        }),
      }),
    }),
  }));
  return { from };
}

function allow(supabase: unknown) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("POST /api/import/batches/[id]/apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ordinary case: no sibling batch for this file has any applied rows.
    // Every test below that doesn't care about the guard itself relies on
    // this default.
    mockFindSiblingWithAppliedRows.mockResolvedValue({ ok: true, conflictBatchId: null });
  });

  it("denies before checking the batch when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const response = await POST(request(), { params: params() });
    expect(response.status).toBe(401);
    expect(mockApplyImportBatchChunk).not.toHaveBeenCalled();
  });

  it("404s for a batch not visible to this tenant, never calling apply", async () => {
    allow(makeSupabase(null));
    const response = await POST(request(), { params: params() });
    expect(response.status).toBe(404);
    expect(mockApplyImportBatchChunk).not.toHaveBeenCalled();
  });

  it("reports done:false while eligible rows remain", async () => {
    allow(makeSupabase({ id: BATCH_ID, content_sha256: null }, { status: "applying" }));
    mockApplyImportBatchChunk.mockResolvedValue({
      processed: [{ rowId: "r1", rowNumber: 1, outcome: "applied", inventoryItemId: "i1", errorMessage: null }],
      status: "applying",
      counts: { total: 10, applied: 5, excluded: 0, pending: 0, eligibleNotApplied: 5 },
    });
    const response = await POST(request(), { params: params() });
    const body = await response.json();
    expect(body.done).toBe(false);
    expect(body.status).toBe("applying");
  });

  it("reports done:true once nothing eligible remains", async () => {
    allow(makeSupabase({ id: BATCH_ID, content_sha256: null }, { status: "completed" }));
    mockApplyImportBatchChunk.mockResolvedValue({
      processed: [],
      status: "completed",
      counts: { total: 10, applied: 10, excluded: 0, pending: 0, eligibleNotApplied: 0 },
    });
    const response = await POST(request(), { params: params() });
    const body = await response.json();
    expect(body.done).toBe(true);
  });

  // Round-8 audit finding 3, WARN 4 (round-9/10 audit): apply_import_batch_
  // chunk_v2 (0108) already no-ops on a reverted batch, but the not-yet-
  // applied rows it leaves alone keep eligibleNotApplied > 0 forever —
  // recomputeBatchStatus's own derived `status` can never report "reverted"
  // either (its update is `.neq("status","reverted")`). Without reading the
  // batch's ACTUAL status, `done` would never flip true and a client would
  // keep polling apply futilely. WARN 4: that real-status read now happens
  // AFTER the apply attempt — this test's mock returns "created" on the
  // pre-apply read and "reverted" only on the post-apply one, pinning that
  // a revert landing DURING the apply call is still caught by THIS response.
  it("reports done:true and batchStatus 'reverted' when the batch is reverted mid-call, even though eligibleNotApplied is still nonzero", async () => {
    allow(makeSupabase({ id: BATCH_ID, content_sha256: null }, { status: "reverted" }));
    mockApplyImportBatchChunk.mockResolvedValue({
      processed: [],
      // apply_import_batch_chunk_v2 no-ops on a reverted batch — its own
      // derived status stays whatever it was before the revert.
      status: "created",
      counts: { total: 10, applied: 0, excluded: 0, pending: 0, eligibleNotApplied: 10 },
    });
    const response = await POST(request(), { params: params() });
    const body = await response.json();
    expect(body.batchStatus).toBe("reverted");
    expect(body.done).toBe(true);
  });

  // Round-10 audit BLOCK 1's replacement enforcement point: apply is
  // refused, never attempted, when a sibling live batch for the same
  // underlying file already has applied rows.
  describe("apply-time sibling-applied guard", () => {
    it("refuses to apply, with a 409 and never calling applyImportBatchChunk, when a sibling batch already has applied rows", async () => {
      allow(makeSupabase({ id: BATCH_ID, content_sha256: "a".repeat(64) }));
      mockFindSiblingWithAppliedRows.mockResolvedValue({ ok: true, conflictBatchId: "sibling-batch-id" });

      const response = await POST(request(), { params: params() });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error.code).toBe("sibling_already_applied");
      expect(mockApplyImportBatchChunk).not.toHaveBeenCalled();
    });

    it("passes this batch's own restaurantId, id, and content_sha256 to the guard", async () => {
      allow(makeSupabase({ id: BATCH_ID, content_sha256: "b".repeat(64) }));
      mockApplyImportBatchChunk.mockResolvedValue({
        processed: [],
        status: "completed",
        counts: { total: 1, applied: 1, excluded: 0, pending: 0, eligibleNotApplied: 0 },
      });

      await POST(request(), { params: params() });

      expect(mockFindSiblingWithAppliedRows).toHaveBeenCalledWith(
        expect.anything(),
        "restaurant-a",
        BATCH_ID,
        "b".repeat(64),
      );
    });

    it("maps the database barrier's P0004 to the same 409 the pre-flight guard returns", async () => {
      // 0128's barrier is the authoritative check — it runs under an advisory
      // lock inside the apply transaction, so it catches the concurrent and
      // direct-RPC cases the pre-flight guard structurally cannot. Here the
      // guard sees nothing and the RPC raises: the client must still get one
      // consistent refusal, not a 500.
      allow(makeSupabase({ id: BATCH_ID, content_sha256: "d".repeat(64) }));
      mockFindSiblingWithAppliedRows.mockResolvedValue({ ok: true, conflictBatchId: null });
      mockApplyImportBatchChunk.mockRejectedValue(
        Object.assign(new Error("another import batch for this underlying file already has applied rows"), {
          code: "P0004",
        }),
      );

      const response = await POST(request(), { params: params() });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error.code).toBe("sibling_already_applied");
    });

    it("returns the identical message whichever layer refuses, so the two cannot drift", async () => {
      allow(makeSupabase({ id: BATCH_ID, content_sha256: "e".repeat(64) }));
      mockFindSiblingWithAppliedRows.mockResolvedValue({ ok: true, conflictBatchId: "sibling-batch-id" });
      const guardBody = await (await POST(request(), { params: params() })).json();

      allow(makeSupabase({ id: BATCH_ID, content_sha256: "e".repeat(64) }));
      mockFindSiblingWithAppliedRows.mockResolvedValue({ ok: true, conflictBatchId: null });
      mockApplyImportBatchChunk.mockRejectedValue(Object.assign(new Error("barrier"), { code: "P0004" }));
      const barrierBody = await (await POST(request(), { params: params() })).json();

      expect(barrierBody.error.message).toBe(guardBody.error.message);
    });

    it("rethrows a non-P0004 RPC failure instead of reporting a sibling conflict", async () => {
      allow(makeSupabase({ id: BATCH_ID, content_sha256: "f".repeat(64) }));
      mockFindSiblingWithAppliedRows.mockResolvedValue({ ok: true, conflictBatchId: null });
      mockApplyImportBatchChunk.mockRejectedValue(Object.assign(new Error("boom"), { code: "P0002" }));

      const response = await POST(request(), { params: params() });

      expect(response.status).not.toBe(409);
    });

    it("propagates a guard lookup failure as a 409 without ever calling applyImportBatchChunk", async () => {
      allow(makeSupabase({ id: BATCH_ID, content_sha256: "c".repeat(64) }));
      mockFindSiblingWithAppliedRows.mockResolvedValue({
        ok: false,
        error: { code: "duplicate_check_failed", message: "Could not verify this file wasn't already imported." },
      });

      const response = await POST(request(), { params: params() });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error.code).toBe("duplicate_check_failed");
      expect(mockApplyImportBatchChunk).not.toHaveBeenCalled();
    });
  });
});
