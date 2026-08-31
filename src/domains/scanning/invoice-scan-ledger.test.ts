import { describe, expect, it } from "vitest";
import { makeScan } from "@/test/fixtures/invoices/scans";
import {
  claimOrCreateInvoiceScanRow,
  markInvoiceScanSaveFailed,
  parseInvoiceDate,
} from "./invoice-scan-ledger";

/**
 * T2 — one invoice, one ledger row.
 *
 * The defect: POST /api/scan creates an `invoice_scans` row, then
 * POST /api/inventory/save-scan inserted a SECOND independent row for the
 * same invoice and never linked them, so the ledger accumulated an orphan
 * extraction row on every /scan → results → "Save to Inventory" pass.
 */

const SCAN_ID = "11111111-2222-3333-4444-555555555555";

type Filter = [string, unknown];
type Filters = Filter[];

/** Records what the caller actually asked the database to do. */
function stubSupabase(opts: {
  claimedRows?: Array<{ id: string }>;
  existingRow?: { id: string } | null;
  insertResult?: { data: { id: string } | null; error: unknown };
}) {
  const log = {
    inserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    updateFilters: [] as Filters[],
    selects: 0,
  };
  const supabase = {
    from: (table: string) => {
      if (table !== "invoice_scans") throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: Record<string, unknown>) => {
          log.inserts.push(row);
          return {
            select: () => ({
              single: async () =>
                opts.insertResult ?? { data: { id: SCAN_ID }, error: null },
            }),
          };
        },
        update: (row: Record<string, unknown>) => {
          log.updates.push(row);
          const filters: Filters = [];
          log.updateFilters.push(filters);
          const chain: Record<string, unknown> = {
            eq: (column: string, value: unknown) => {
              filters.push([column, value]);
              return chain;
            },
            is: (column: string, value: unknown) => {
              filters.push([column, value]);
              return chain;
            },
            select: () => chain,
            then: (resolve: (value: unknown) => unknown) =>
              resolve({ data: opts.claimedRows ?? [], error: null }),
          };
          return chain;
        },
        select: () => {
          log.selects += 1;
          const chain: Record<string, unknown> = {
            eq: () => chain,
            maybeSingle: async () => ({
              data: opts.existingRow ?? null,
              error: null,
            }),
          };
          return chain;
        },
      };
    },
  };
  return { supabase: supabase as never, log };
}

describe("claimOrCreateInvoiceScanRow", () => {
  it("UPDATES the row POST /api/scan already created instead of inserting a duplicate", async () => {
    const { supabase, log } = stubSupabase({ claimedRows: [{ id: SCAN_ID }] });
    const scan = makeScan({ scanId: SCAN_ID });

    const result = await claimOrCreateInvoiceScanRow({
      supabase,
      restaurantId: "restaurant-A",
      scan,
      originalItems: scan.items,
      accuracyScore: 1,
    });

    expect(result).toEqual({ ok: true, scanId: SCAN_ID, created: false });
    expect(log.inserts).toHaveLength(0);
    expect(log.updates).toHaveLength(1);
    expect(log.updates[0]).toMatchObject({
      distributor_name: "Test Distributor",
      invoice_number: "INV-1001",
      invoice_date: "2026-04-01",
      item_count: 2,
      status: "complete",
      status_reason: null,
    });
    // The same compare-and-swap POST /api/scans/[id]/commit uses: tenant
    // scoped, and fenced on the row not already being committed.
    expect(log.updateFilters[0]).toEqual([
      ["id", SCAN_ID],
      ["restaurant_id", "restaurant-A"],
      ["committed_at", null],
    ]);
  });

  it("INSERTS when the caller has no prior scan row (the manual-entry flow)", async () => {
    const { supabase, log } = stubSupabase({});
    const scan = makeScan();
    expect(scan.scanId).toBeUndefined();

    const result = await claimOrCreateInvoiceScanRow({
      supabase,
      restaurantId: "restaurant-A",
      scan,
      originalItems: scan.items,
      accuracyScore: 0.5,
    });

    expect(result).toEqual({ ok: true, scanId: SCAN_ID, created: true });
    expect(log.updates).toHaveLength(0);
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0]).toMatchObject({
      restaurant_id: "restaurant-A",
      status: "complete",
      accuracy_score: 0.5,
    });
  });

  it("returns 409 when the fence finds the scan already committed", async () => {
    const { supabase } = stubSupabase({
      claimedRows: [],
      existingRow: { id: SCAN_ID },
    });
    const scan = makeScan({ scanId: SCAN_ID });

    const result = await claimOrCreateInvoiceScanRow({
      supabase,
      restaurantId: "restaurant-A",
      scan,
      originalItems: scan.items,
      accuracyScore: 1,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        error: {
          code: "scan_already_committed",
          message: "This scan has already been saved to inventory.",
        },
      },
    });
  });

  it("returns 404 for a scan id that is not this tenant's", async () => {
    const { supabase } = stubSupabase({ claimedRows: [], existingRow: null });
    const scan = makeScan({ scanId: SCAN_ID });

    const result = await claimOrCreateInvoiceScanRow({
      supabase,
      restaurantId: "restaurant-A",
      scan,
      originalItems: scan.items,
      accuracyScore: 1,
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});

/**
 * A stateful fake, unlike `stubSupabase` above: inserts and updates act on
 * the same backing rows, so the fence (`committed_at IS NULL`) is evaluated
 * against whatever the previous call actually left behind — exactly what
 * `stubSupabase`'s per-call canned responses cannot exercise.
 */
function fakeInvoiceScansTable() {
  const rows = new Map<string, Record<string, unknown>>();
  let nextId = 0;
  const matches = (row: Record<string, unknown>, filters: Filters) =>
    filters.every(([column, value]) => (row[column] ?? null) === value);

  const supabase = {
    from: (table: string) => {
      if (table !== "invoice_scans") throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: Record<string, unknown>) => {
          const id = `row-${++nextId}`;
          // Real Postgres: a column with no value in the insert and no
          // column default (committed_at, per 0090) reads back as NULL.
          rows.set(id, { committed_at: null, ...row, id });
          return { select: () => ({ single: async () => ({ data: { id }, error: null }) }) };
        },
        update: (patch: Record<string, unknown>) => {
          const filters: Filters = [];
          const chain: Record<string, unknown> = {
            eq: (column: string, value: unknown) => {
              filters.push([column, value]);
              return chain;
            },
            is: (column: string, value: unknown) => {
              filters.push([column, value]);
              return chain;
            },
            select: () => chain,
            then: (resolve: (value: unknown) => unknown) => {
              const claimed = [...rows.values()].filter((row) => matches(row, filters));
              for (const row of claimed) Object.assign(row, patch);
              return resolve({ data: claimed.map((row) => ({ id: row.id })), error: null });
            },
          };
          return chain;
        },
        select: () => {
          const filters: Filters = [];
          const chain: Record<string, unknown> = {
            eq: (column: string, value: unknown) => {
              filters.push([column, value]);
              return chain;
            },
            maybeSingle: async () => {
              const found = [...rows.values()].find((row) => matches(row, filters));
              return { data: found ? { id: found.id } : null, error: null };
            },
          };
          return chain;
        },
      };
    },
  };
  return { supabase: supabase as never, rows };
}

describe("claimOrCreateInvoiceScanRow — insert-then-reclaim", () => {
  it("does not let a second claim on a freshly-inserted row succeed", async () => {
    const { supabase } = fakeInvoiceScansTable();
    const created = await claimOrCreateInvoiceScanRow({
      supabase,
      restaurantId: "restaurant-A",
      scan: makeScan(),
      originalItems: [],
      accuracyScore: 1,
    });
    expect(created).toMatchObject({ ok: true, created: true });
    if (!created.ok) throw new Error("unreachable");

    // A double-tap, a retried request, or a commit racing this save —
    // any later call that learns this row's id and tries to claim it again
    // must be fenced out, exactly like re-claiming an update-path row is.
    const reclaimed = await claimOrCreateInvoiceScanRow({
      supabase,
      restaurantId: "restaurant-A",
      scan: makeScan({ scanId: created.scanId }),
      originalItems: [],
      accuracyScore: 1,
    });

    expect(reclaimed).toEqual({
      ok: false,
      status: 409,
      body: {
        error: {
          code: "scan_already_committed",
          message: "This scan has already been saved to inventory.",
        },
      },
    });
  });
});

describe("markInvoiceScanSaveFailed", () => {
  it("keeps the row, states the reason, and releases the claim", async () => {
    const { supabase, log } = stubSupabase({});
    await markInvoiceScanSaveFailed(supabase, "restaurant-A", SCAN_ID);

    expect(log.updates).toEqual([
      { status_reason: "inventory_save_failed", committed_at: null },
    ]);
    expect(log.updateFilters[0]).toEqual([
      ["id", SCAN_ID],
      ["restaurant_id", "restaurant-A"],
    ]);
  });
});

describe("parseInvoiceDate", () => {
  it.each([
    ["2024-03-15", "2024-03-15"],
    ["—", null],
    ["-", null],
    ["", null],
    ["not a date", null],
  ])("maps %s to %s", (input, expected) => {
    expect(parseInvoiceDate(input)).toBe(expected);
  });
});
