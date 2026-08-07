import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { makeScan, makeLineItem } from "@/test/fixtures/invoices/scans";

/**
 * /api/inventory/save-scan route tests (BND-010).
 *
 * The route is the final leg of the scan workflow — it writes an
 * `invoice_scans` row, batch-upserts wines, batch-inserts inventory, and
 * kicks off an LWIN match. Characterization tests cover:
 *   1. Auth: 401 / 403 never reach any DB write
 *   2. Bad input: 400 on missing scan, missing originalItems, bad JSON
 *   3. Happy path: returns scanId + counts
 *   4. DB error on invoice_scans insert → 500, no wines created
 *   5. DB error on find_or_create_wines_batch RPC → invoice_scans row is
 *      rolled back (delete is called) and the caller sees a 500
 */

// ── requireMembership stub ───────────────────────────────────────────────

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

// ── Supabase chainable stub ──────────────────────────────────────────────
//
// The builder mutates a per-call state bag and returns the requested shape
// at .single() / await-resolution time. Each call to .from(table) returns
// a fresh builder; delete / update / insert / select / eq chain freely.
//
// Programmability: tests configure `supabaseBehavior` before each scenario.

type InsertResult = { data: { id: string } | null; error: unknown };
type RpcResult = { data: unknown; error: unknown };
type UploadResult = { error: unknown };

type SupabaseBehavior = {
  invoiceScansInsert: InsertResult;
  invoiceScansDelete: { error: unknown };
  invoiceScansUpdate: { error: unknown };
  inventoryItemsInsert: { error: unknown };
  findOrCreateWinesBatch: RpcResult;
  matchLwinBatch: RpcResult;
  storageUpload: UploadResult;
};

const supabaseBehavior: SupabaseBehavior = {
  invoiceScansInsert: { data: { id: "scan-123" }, error: null },
  invoiceScansDelete: { error: null },
  invoiceScansUpdate: { error: null },
  inventoryItemsInsert: { error: null },
  findOrCreateWinesBatch: { data: ["wine-1", "wine-2"], error: null },
  matchLwinBatch: { data: [], error: null },
  storageUpload: { error: null },
};

const calls: {
  deleteInvoiceScanCalled: boolean;
  inventoryInserts: unknown[];
  rpc: Array<{ fn: string; args: unknown }>;
} = {
  deleteInvoiceScanCalled: false,
  inventoryInserts: [],
  rpc: [],
};

function resetSupabaseCallRecords() {
  calls.deleteInvoiceScanCalled = false;
  calls.inventoryInserts = [];
  calls.rpc = [];
}

function buildSupabaseStub() {
  return {
    from(table: string) {
      if (table === "invoice_scans") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => supabaseBehavior.invoiceScansInsert,
            }),
          }),
          delete: () => ({
            eq: async () => {
              calls.deleteInvoiceScanCalled = true;
              return supabaseBehavior.invoiceScansDelete;
            },
          }),
          update: () => ({
            eq: async () => supabaseBehavior.invoiceScansUpdate,
          }),
        };
      }
      if (table === "inventory_items") {
        return {
          insert: async (rows: unknown) => {
            calls.inventoryInserts.push(rows);
            return supabaseBehavior.inventoryItemsInsert;
          },
        };
      }
      throw new Error(`unexpected .from("${table}")`);
    },
    async rpc(fn: string, args: unknown) {
      calls.rpc.push({ fn, args });
      if (fn === "find_or_create_wines_batch") {
        return supabaseBehavior.findOrCreateWinesBatch;
      }
      if (fn === "match_lwin_batch") {
        // The route uses `.then(...)` so this branch has to behave like a
        // thenable. Returning a resolved value works because our caller
        // `await`s us.
        return supabaseBehavior.matchLwinBatch;
      }
      throw new Error(`unexpected rpc("${fn}")`);
    },
    storage: {
      from: () => ({
        upload: async () => supabaseBehavior.storageUpload,
      }),
    },
  };
}

// ── Request helpers ──────────────────────────────────────────────────────

function makeJsonRequest(body: unknown) {
  return new Request("http://localhost/api/inventory/save-scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function makeMultipartRequest(entries: Array<[string, string | File]>) {
  const form = new FormData();
  for (const [key, value] of entries) form.append(key, value);
  return new Request("http://localhost/api/inventory/save-scan", {
    method: "POST",
    body: form,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function authedAsA() {
  mockRequireMembership.mockResolvedValue({
    supabase: buildSupabaseStub(),
    user: { id: "u1" },
    restaurantId: "restaurant-A",
    role: "owner",
  });
}

const { POST } = await import("./route");

// ── Tests ────────────────────────────────────────────────────────────────

describe("POST /api/inventory/save-scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSupabaseCallRecords();
    supabaseBehavior.invoiceScansInsert = {
      data: { id: "scan-123" },
      error: null,
    };
    supabaseBehavior.invoiceScansDelete = { error: null };
    supabaseBehavior.invoiceScansUpdate = { error: null };
    supabaseBehavior.inventoryItemsInsert = { error: null };
    supabaseBehavior.findOrCreateWinesBatch = {
      data: ["wine-1", "wine-2"],
      error: null,
    };
    supabaseBehavior.matchLwinBatch = { data: [], error: null };
    supabaseBehavior.storageUpload = { error: null };
  });

  // ── Auth ──────────────────────────────────────────────────────────────

  it("returns 401 and never writes to the database", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await POST(
      makeJsonRequest({ scan: makeScan(), originalItems: [makeLineItem()] }),
    );

    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(401);
    expect(calls.rpc).toHaveLength(0);
    expect(calls.inventoryInserts).toHaveLength(0);
  });

  it("returns 403 when the user has no membership", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json(
        { error: "No restaurant membership found." },
        { status: 403 },
      ),
    );
    const res = await POST(
      makeJsonRequest({ scan: makeScan(), originalItems: [makeLineItem()] }),
    );
    expect(res.status).toBe(403);
    expect(calls.rpc).toHaveLength(0);
  });

  // ── Bad input ─────────────────────────────────────────────────────────

  it("returns 400 when the body is not valid JSON", async () => {
    authedAsA();
    const res = await POST(makeJsonRequest("{not-json"));
    expect(res.status).toBe(400);
    expect(calls.rpc).toHaveLength(0);
  });

  it("returns 400 when the scan has no items", async () => {
    authedAsA();
    const res = await POST(
      makeJsonRequest({
        scan: makeScan({ items: [] }),
        originalItems: [],
      }),
    );
    expect(res.status).toBe(400);
    expect(calls.rpc).toHaveLength(0);
  });

  it("returns 400 when originalItems is not an array", async () => {
    authedAsA();
    const res = await POST(
      makeJsonRequest({
        scan: makeScan(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        originalItems: "not-an-array" as any,
      }),
    );
    expect(res.status).toBe(400);
    expect(calls.rpc).toHaveLength(0);
  });

  it("rejects invalid nested line-item fields before persistence", async () => {
    authedAsA();
    const scan = makeScan({
      items: [makeLineItem({ qty: 1.5 })],
    });

    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: expect.arrayContaining([
          expect.objectContaining({
            path: ["scan", "items", 0, "qty"],
          }),
        ]),
      },
    });
    expect(calls.rpc).toHaveLength(0);
  });

  it("blocks low-confidence inventory writes until review is recorded", async () => {
    authedAsA();
    const scan = makeScan({
      items: [
        makeLineItem({
          confidence: 0.7,
          lowFields: ["producer"],
        }),
      ],
    });

    const response = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "low_confidence_review_required",
        message: "Review low-confidence scan fields before saving inventory.",
      },
    });
    expect(calls.rpc).toHaveLength(0);
    expect(calls.inventoryInserts).toHaveLength(0);
  });

  it("allows a low-confidence inventory write after explicit review", async () => {
    authedAsA();
    const scan = makeScan({
      reviewedLowConfidence: true,
      items: [
        makeLineItem({
          confidence: 0.7,
          lowFields: ["producer"],
        }),
      ],
    });
    supabaseBehavior.findOrCreateWinesBatch = {
      data: ["wine-1"],
      error: null,
    };

    const response = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(response.status).toBe(200);
    expect(calls.inventoryInserts).toHaveLength(1);
  });

  it("rejects duplicate multipart data fields", async () => {
    authedAsA();
    const scan = makeScan();
    const data = JSON.stringify({ scan, originalItems: scan.items });

    const res = await POST(
      makeMultipartRequest([
        ["data", data],
        ["data", data],
      ]),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["data"] }],
      },
    });
    expect(calls.rpc).toHaveLength(0);
  });

  it("rejects duplicate multipart file fields", async () => {
    authedAsA();
    const scan = makeScan();
    const data = JSON.stringify({ scan, originalItems: scan.items });

    const res = await POST(
      makeMultipartRequest([
        ["data", data],
        ["file", new File(["one"], "one.jpg", { type: "image/jpeg" })],
        ["file", new File(["two"], "two.jpg", { type: "image/jpeg" })],
      ]),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["file"] }],
      },
    });
    expect(calls.rpc).toHaveLength(0);
  });

  // ── Happy path ────────────────────────────────────────────────────────

  it("returns the scanId and counts on success", async () => {
    authedAsA();

    const scan = makeScan();
    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanId).toBe("scan-123");
    expect(body.itemCount).toBe(2);
    expect(body.wineCount).toBe(2);

    // The route went all the way through: wines RPC + inventory insert.
    expect(
      calls.rpc.find((c) => c.fn === "find_or_create_wines_batch"),
    ).toEqual({
      fn: "find_or_create_wines_batch",
      args: expect.objectContaining({ p_restaurant_id: "restaurant-A" }),
    });
    expect(calls.inventoryInserts).toHaveLength(1);
    expect(calls.inventoryInserts[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ restaurant_id: "restaurant-A" }),
      ]),
    );
  });

  it("preserves multipart save success", async () => {
    authedAsA();
    const scan = makeScan();

    const res = await POST(
      makeMultipartRequest([
        ["data", JSON.stringify({ scan, originalItems: scan.items })],
        ["file", new File(["invoice"], "invoice.jpg", { type: "image/jpeg" })],
      ]),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      scanId: "scan-123",
      itemCount: 2,
      wineCount: 2,
    });
    expect(calls.inventoryInserts).toHaveLength(1);
  });

  // ── Upstream failures ─────────────────────────────────────────────────

  it("returns 500 when the invoice_scans insert fails (no downstream work)", async () => {
    authedAsA();
    supabaseBehavior.invoiceScansInsert = {
      data: null,
      error: { message: "unique_violation" },
    };

    const scan = makeScan();
    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    // No wines RPC, no inventory insert.
    expect(calls.rpc).toHaveLength(0);
    expect(calls.inventoryInserts).toHaveLength(0);
  });

  it("rolls back the invoice_scans row when find_or_create_wines_batch fails", async () => {
    authedAsA();
    supabaseBehavior.findOrCreateWinesBatch = {
      data: null,
      error: { message: "db down" },
    };

    const scan = makeScan();
    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    // The route must delete the invoice_scans row we just inserted to
    // avoid stranding a parent row with no children.
    expect(calls.deleteInvoiceScanCalled).toBe(true);
    expect(calls.inventoryInserts).toHaveLength(0);
  });

  it("rolls back the invoice_scans row when inventory_items insert fails", async () => {
    authedAsA();
    supabaseBehavior.inventoryItemsInsert = {
      error: { message: "fk violation" },
    };

    const scan = makeScan();
    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    // Wines were created, but inventory failed — clean up the parent row.
    expect(calls.inventoryInserts).toHaveLength(1);
    expect(calls.deleteInvoiceScanCalled).toBe(true);
  });
});
