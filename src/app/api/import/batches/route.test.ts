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

// Stubbed so the assertion below pins the WIRING (the route hands the service
// client it built to confirmImportBatch) rather than whichever value the
// ambient environment happens to produce: unset service-role env vars resolve
// to null locally, but CI exports a real local-Supabase service key.
const serviceClientStub = { __serviceRoleStub: true };
vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => serviceClientStub,
}));

const { GET, POST } = await import("./route");

function multipartRequest(file: File, extraFields?: Record<string, string>) {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(extraFields ?? {})) form.append(key, value);
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
      alreadyExists: false,
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
      {
        sessionId: undefined,
        chunkIndex: undefined,
        chunkTotal: undefined,
        sourceSha256: undefined,
        rowOverrides: undefined,
        // Pins the wiring: whatever createServiceRoleClient() returns is what
        // confirmImportBatch receives, so revert-time orphan cleanup keeps its
        // service-role reads. Stubbed above because the real factory's result
        // depends on env vars that differ between local runs and CI.
        serviceClient: serviceClientStub,
      },
    );
  });

  it("P3 §2.2: surfaces a duplicate-content resume pointer as 200, not 201", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({
      ok: true,
      alreadyExists: true,
      batchId: "batch-1",
      status: "applying",
      sessionId: null,
      counts: { total: 5, applied: 3, excluded: 0, pending: 0, eligibleNotApplied: 2 },
    });
    const response = await POST(multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" })));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ batchId: "batch-1", alreadyExists: true, status: "applying" });
  });

  it("surfaces the duplicate batch's own sessionId — the caller needs it to detect a cross-session collision", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({
      ok: true,
      alreadyExists: true,
      batchId: "batch-1",
      status: "created",
      sessionId: "session-old",
      counts: { total: 5, applied: 0, excluded: 0, pending: 0, eligibleNotApplied: 5 },
    });
    const response = await POST(multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" })));
    const body = await response.json();
    expect(body).toMatchObject({ sessionId: "session-old" });
  });

  it("surfaces a confirm-level validation error as 422", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({ ok: false, error: { code: "empty_file", message: "CSV has no data rows." } });
    const response = await POST(multipartRequest(new File(["producer,name,quantity\n"], "cellar.csv", { type: "text/csv" })));
    expect(response.status).toBe(422);
  });

  it("parses a valid rowOverrides field and forwards it to confirmImportBatch", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({
      ok: true,
      alreadyExists: false,
      batchId: "batch-1",
      totalRows: 1,
      summary: { totalRows: 1 },
    });
    const response = await POST(
      multipartRequest(new File(["producer,name,quantity\nA,B,0.9"], "cellar.csv", { type: "text/csv" }), {
        rowOverrides: JSON.stringify({ "1": { quantity: "1" } }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mockConfirmImportBatch).toHaveBeenCalledWith(
      expect.anything(),
      "restaurant-a",
      "user-a",
      "cellar.csv",
      expect.any(Buffer),
      expect.objectContaining({ rowOverrides: { "1": { quantity: "1" } } }),
    );
  });

  // SD-41 — the blank-producer acknowledgement is a multipart field, so it
  // arrives as a STRING and must reach the domain as a number. Its ABSENCE
  // must also survive the boundary as `undefined`, never a defaulted 0:
  // "this caller acknowledged nothing" is precisely what confirm refuses.
  it("coerces the acknowledgedMissingProducerRows field to a number and forwards it", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({
      ok: true,
      alreadyExists: false,
      batchId: "batch-1",
      totalRows: 1,
      summary: { totalRows: 1 },
    });
    const response = await POST(
      multipartRequest(new File(["wine name,quantity\nA.F. Gros Richebourg,1"], "cellar.csv", { type: "text/csv" }), {
        acknowledgedMissingProducerRows: "3",
      }),
    );
    expect(response.status).toBe(201);
    expect(mockConfirmImportBatch).toHaveBeenCalledWith(
      expect.anything(),
      "restaurant-a",
      "user-a",
      "cellar.csv",
      expect.any(Buffer),
      expect.objectContaining({ acknowledgedMissingProducerRows: 3 }),
    );
  });

  it("forwards acknowledgedMissingProducerRows as undefined when the field is absent", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({
      ok: true,
      alreadyExists: false,
      batchId: "batch-1",
      totalRows: 1,
      summary: { totalRows: 1 },
    });
    await POST(multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" })));
    expect(mockConfirmImportBatch.mock.calls[0][5]).toMatchObject({ acknowledgedMissingProducerRows: undefined });
  });

  it("rejects a negative acknowledgedMissingProducerRows before calling confirmImportBatch", async () => {
    allow();
    const response = await POST(
      multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" }), {
        acknowledgedMissingProducerRows: "-1",
      }),
    );
    expect(response.status).toBe(400);
    expect(mockConfirmImportBatch).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON in rowOverrides before calling confirmImportBatch", async () => {
    allow();
    const response = await POST(
      multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" }), {
        rowOverrides: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    expect(mockConfirmImportBatch).not.toHaveBeenCalled();
  });

  it("rejects a rowOverrides field name outside the canonical whitelist", async () => {
    allow();
    const response = await POST(
      multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" }), {
        rowOverrides: JSON.stringify({ "1": { not_a_real_field: "x" } }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mockConfirmImportBatch).not.toHaveBeenCalled();
  });

  it("rejects a non-integer rowOverrides row index", async () => {
    allow();
    const response = await POST(
      multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" }), {
        rowOverrides: JSON.stringify({ "not-a-number": { quantity: "1" } }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mockConfirmImportBatch).not.toHaveBeenCalled();
  });

  // Sol audit (2026-08-27) finding 3: row-key validation used to fail
  // OPEN — "01"/"0" were accepted by the schema then silently mismatched
  // preview's own String(rowNumber) lookup ("1", never "01"), and
  // "__proto__" reduced to {} with no error at all (zod's z.record()
  // silently drops it rather than rejecting it). Every one of these must
  // now 400 instead.
  it.each([["0"], ["01"], ["007"], ["__proto__"]])(
    "rejects the non-canonical rowOverrides row index %j with a 400, not a silent drop",
    async (key) => {
      allow();
      const response = await POST(
        multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" }), {
          rowOverrides: JSON.stringify({ [key]: { quantity: "1" } }),
        }),
      );
      expect(response.status).toBe(400);
      expect(mockConfirmImportBatch).not.toHaveBeenCalled();
    },
  );

  it("accepts a canonical positive-integer rowOverrides row index", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({
      ok: true,
      alreadyExists: false,
      batchId: "batch-1",
      totalRows: 1,
      summary: { totalRows: 1 },
    });
    const response = await POST(
      multipartRequest(new File(["producer,name,quantity\nA,B,0.9"], "cellar.csv", { type: "text/csv" }), {
        rowOverrides: JSON.stringify({ "10": { quantity: "1" } }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mockConfirmImportBatch).toHaveBeenCalledWith(
      expect.anything(),
      "restaurant-a",
      "user-a",
      "cellar.csv",
      expect.any(Buffer),
      expect.objectContaining({ rowOverrides: { "10": { quantity: "1" } } }),
    );
  });

  // Sol audit (2026-08-27) finding 4: an over-length override value must
  // never 400 the whole request — validateFields (shared client/server
  // logic) turns it into a normal per-row field error instead, so confirm
  // still creates the batch (with that one row as an error row, exactly
  // like any other invalid override).
  it("does not reject the whole request for an over-MAX_FIELD_LENGTH override value", async () => {
    allow();
    mockConfirmImportBatch.mockResolvedValue({
      ok: true,
      alreadyExists: false,
      batchId: "batch-1",
      totalRows: 1,
      summary: { totalRows: 1 },
    });
    const response = await POST(
      multipartRequest(new File(["producer,name,quantity\nA,B,1"], "cellar.csv", { type: "text/csv" }), {
        rowOverrides: JSON.stringify({ "1": { name: "x".repeat(2001) } }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mockConfirmImportBatch).toHaveBeenCalled();
  });
});
