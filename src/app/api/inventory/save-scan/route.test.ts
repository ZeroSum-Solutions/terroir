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
 *   5. DB error on find_or_create_wines_batch RPC → the invoice_scans row
 *      STAYS (D6 rule 1) but records status_reason=inventory_save_failed
 *      and releases its claim, and the caller sees a 500
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
  invoiceScansUpdate: { error: unknown };
  inventoryItemsInsert: { error: unknown };
  findOrCreateWinesBatch: RpcResult;
  matchLwinBatch: RpcResult;
  storageUpload: UploadResult;
};

const supabaseBehavior: SupabaseBehavior = {
  invoiceScansInsert: { data: { id: "scan-123" }, error: null },
  invoiceScansUpdate: { error: null },
  inventoryItemsInsert: { error: null },
  findOrCreateWinesBatch: { data: ["wine-1", "wine-2"], error: null },
  matchLwinBatch: { data: [], error: null },
  storageUpload: { error: null },
};

const calls: {
  inventoryInserts: unknown[];
  invoiceScansInserts: unknown[];
  invoiceScansUpdates: Record<string, unknown>[];
  rpc: Array<{ fn: string; args: unknown }>;
} = {
  inventoryInserts: [],
  invoiceScansInserts: [],
  invoiceScansUpdates: [],
  rpc: [],
};

function resetSupabaseCallRecords() {
  calls.inventoryInserts = [];
  calls.invoiceScansInserts = [];
  calls.invoiceScansUpdates = [];
  calls.rpc = [];
}

function buildSupabaseStub() {
  return {
    from(table: string) {
      if (table === "invoice_scans") {
        return {
          insert: (row: unknown) => {
            calls.invoiceScansInserts.push(row);
            return {
              select: () => ({
                single: async () => supabaseBehavior.invoiceScansInsert,
              }),
            };
          },
          update: (row: Record<string, unknown>) => {
            calls.invoiceScansUpdates.push(row);
            // Chainable: .eq().eq() marks a failed save; .eq().eq().is().select() claims.
            const chain: Record<string, unknown> = {
              eq: () => chain, is: () => chain, select: () => chain,
              then: (r: (v: unknown) => unknown) =>
                r({ data: [{ id: "scan-123" }], ...supabaseBehavior.invoiceScansUpdate }),
            };
            return chain;
          },
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

const SAVE_FAILED_MARK = { status_reason: "inventory_save_failed", committed_at: null };
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
    // D6 rule 1: the row STAYS and states why nothing reached inventory.
    expect(calls.invoiceScansUpdates).toEqual([SAVE_FAILED_MARK]);
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
    // Wines were created, but inventory failed — the row stays, marked.
    expect(calls.inventoryInserts).toHaveLength(1);
    expect(calls.invoiceScansUpdates).toEqual([SAVE_FAILED_MARK]);
  });

  // ── G1-12: arithmetic re-validation ─────────────────────────────────
  //
  // This is the disqualifying gap a fresh critic found: this route creates
  // the *permanent* invoice_scans + inventory_items rows and previously
  // never re-checked arithmetic on the items it was about to persist — it
  // trusted whatever the client sent. These prove the server re-validates
  // scan.items itself (never a client-supplied "already validated" claim)
  // and refuses to write anything when it doesn't reconcile.

  it("rejects a payload whose line items fail arithmetic validation, before any DB write", async () => {
    authedAsA();
    const scan = makeScan({
      items: [
        // True unit cost is $45 (6 x 45 = $270, the printed line total);
        // this payload carries $18 instead.
        makeLineItem({ id: "item-1", qty: 6, unitCost: 18, lineTotal: 270 }),
      ],
    });

    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("arithmetic_mismatch");
    expect(calls.rpc).toHaveLength(0);
    expect(calls.inventoryInserts).toHaveLength(0);
    expect(calls.invoiceScansInserts).toHaveLength(0);
  });

  it("rejects a payload with inconsistent currencies across line items", async () => {
    authedAsA();
    const scan = makeScan({
      items: [
        makeLineItem({ id: "item-1", currency: "USD" }),
        makeLineItem({
          id: "item-2",
          name: "Cabernet Sauvignon",
          qty: 3,
          unitCost: 850,
          currency: "EUR",
        }),
      ],
    });

    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("arithmetic_mismatch");
    expect(calls.rpc).toHaveLength(0);
    expect(calls.inventoryInserts).toHaveLength(0);
    expect(calls.invoiceScansInserts).toHaveLength(0);
  });

  it("does not trust a client-supplied arithmetic verdict on the scan object", async () => {
    authedAsA();
    // The client claims this scan already passed arithmetic validation —
    // the server must re-check scan.items itself regardless.
    const scan = makeScan({
      items: [makeLineItem({ id: "item-1", qty: 6, unitCost: 18, lineTotal: 270 })],
      arithmetic: { ok: true, issues: [] },
    });

    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(422);
    expect(calls.inventoryInserts).toHaveLength(0);
    expect(calls.invoiceScansInserts).toHaveLength(0);
  });

  it("accepts and persists a payload whose line items reconcile, marking the row complete", async () => {
    authedAsA();
    const scan = makeScan({
      items: [
        makeLineItem({ id: "item-1", qty: 6, unitCost: 32.5, lineTotal: 195 }),
        makeLineItem({
          id: "item-2",
          name: "Cabernet Sauvignon",
          qty: 3,
          unitCost: 850,
          lineTotal: 2550,
        }),
      ],
    });

    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(200);
    expect(calls.inventoryInserts).toHaveLength(1);
    expect(calls.invoiceScansInserts).toHaveLength(1);
    expect(calls.invoiceScansInserts[0]).toMatchObject({ status: "complete" });
  });

  it("still saves an invoice that never prints line totals at all (nothing to check, honestly)", async () => {
    authedAsA();
    const scan = makeScan(); // default fixture carries no lineTotal on either item

    const res = await POST(
      makeJsonRequest({ scan, originalItems: scan.items }),
    );

    expect(res.status).toBe(200);
    expect(calls.inventoryInserts).toHaveLength(1);
  });
});
