import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockRevertImportBatch = vi.fn();
vi.mock("@/domains/import/batch-service", () => ({
  revertImportBatch: (...args: unknown[]) => mockRevertImportBatch(...args),
}));

const { POST } = await import("./route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";

function request() {
  return new Request(`http://localhost/api/import/batches/${BATCH_ID}/revert`, { method: "POST" }) as unknown as NextRequest;
}
function params() {
  return Promise.resolve({ id: BATCH_ID });
}

function makeSupabase(batch: unknown) {
  return {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: batch, error: null }) }),
        }),
      }),
    })),
  };
}

function allow(supabase: unknown) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("POST /api/import/batches/[id]/revert", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404s for a batch not visible to this tenant, never calling revert", async () => {
    allow(makeSupabase(null));
    const response = await POST(request(), { params: params() });
    expect(response.status).toBe(404);
    expect(mockRevertImportBatch).not.toHaveBeenCalled();
  });

  it("returns 409 when the batch isn't completed yet", async () => {
    allow(makeSupabase({ id: BATCH_ID }));
    mockRevertImportBatch.mockResolvedValue({ ok: false, error: { code: "not_completed", message: "Only a completed batch can be reverted." } });
    const response = await POST(request(), { params: params() });
    expect(response.status).toBe(409);
  });

  it("returns the reverted count and orphan-wine cleanup count on success", async () => {
    allow(makeSupabase({ id: BATCH_ID }));
    mockRevertImportBatch.mockResolvedValue({ ok: true, revertedCount: 7, orphanWinesDeleted: 2 });
    const response = await POST(request(), { params: params() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revertedCount: 7, orphanWinesDeleted: 2 });
    expect(mockRevertImportBatch).toHaveBeenCalledWith(expect.anything(), "restaurant-a", BATCH_ID);
  });
});
