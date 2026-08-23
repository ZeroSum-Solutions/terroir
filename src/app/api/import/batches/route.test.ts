import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { __resetRateLimitForTests } from "@/lib/api/rate-limit";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockConfirmImportBatch = vi.fn();
vi.mock("@/domains/import/batch-service", () => ({
  confirmImportBatch: (...args: unknown[]) => mockConfirmImportBatch(...args),
}));

const { GET, POST } = await import("./route");

function multipartRequest(file: File) {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://localhost/api/import/batches", { method: "POST", body: form }) as unknown as NextRequest;
}

function makeSupabase(batches: unknown[] = []) {
  const eqCalls: Array<[string, unknown]> = [];
  const from = vi.fn((table: string) => {
    expect(table).toBe("import_batches");
    return {
      select: () => ({
        eq: (col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return {
            order: async () => ({ data: batches, error: null }),
          };
        },
      }),
    };
  });
  return { client: { from }, eqCalls };
}

function allow(supabase: unknown = { from: vi.fn(), rpc: vi.fn() }) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("GET /api/import/batches", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies before querying when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("scopes the batch list query to the session's restaurant", async () => {
    const { client, eqCalls } = makeSupabase([{ id: "b1", status: "completed" }]);
    allow(client);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(eqCalls).toEqual([["restaurant_id", "restaurant-a"]]);
    expect((await response.json()).batches).toEqual([{ id: "b1", status: "completed" }]);
  });
});

describe("POST /api/import/batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
  });

  it("rejects an oversized upload before calling confirmImportBatch", async () => {
    allow();
    const huge = new File([new Uint8Array(6 * 1024 * 1024)], "cellar.csv", { type: "text/csv" });
    const response = await POST(multipartRequest(huge));
    expect(response.status).toBe(413);
    expect(mockConfirmImportBatch).not.toHaveBeenCalled();
  });

  it("passes the session-derived restaurantId and userId, not client-suppliable values", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({
      ok: true,
      batchId: "batch-1",
      totalRows: 1,
      summary: { totalRows: 1 },
    });
    const response = await POST(multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" })));
    expect(response.status).toBe(201);
    expect(mockConfirmImportBatch).toHaveBeenCalledWith(
      expect.anything(),
      "restaurant-a",
      "user-a",
      "cellar.csv",
      expect.any(Buffer),
    );
  });

  it("surfaces a confirm-level validation error as 422", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({ ok: false, error: { code: "empty_file", message: "CSV has no data rows." } });
    const response = await POST(multipartRequest(new File(["producer,name,quantity\n"], "cellar.csv", { type: "text/csv" })));
    expect(response.status).toBe(422);
  });
});
