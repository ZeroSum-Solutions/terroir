import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockApplyImportBatchChunk = vi.fn();
vi.mock("@/domains/import/batch-service", () => ({
  applyImportBatchChunk: (...args: unknown[]) => mockApplyImportBatchChunk(...args),
}));

const { POST } = await import("./route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";

function request() {
  return new Request(`http://localhost/api/import/batches/${BATCH_ID}/apply`, { method: "POST" }) as unknown as NextRequest;
}
function params() {
  return Promise.resolve({ id: BATCH_ID });
}

function makeSupabase(batch: unknown) {
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: batch, error: null }) }),
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
  beforeEach(() => vi.clearAllMocks());

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
    allow(makeSupabase({ id: BATCH_ID }));
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
    allow(makeSupabase({ id: BATCH_ID }));
    mockApplyImportBatchChunk.mockResolvedValue({
      processed: [],
      status: "completed",
      counts: { total: 10, applied: 10, excluded: 0, pending: 0, eligibleNotApplied: 0 },
    });
    const response = await POST(request(), { params: params() });
    const body = await response.json();
    expect(body.done).toBe(true);
  });
});
