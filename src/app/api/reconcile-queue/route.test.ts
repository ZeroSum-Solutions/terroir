import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import {
  BIN_ID,
  INVENTORY_ID,
  LINEAGE_ID,
  RESTAURANT_ID,
  SCAN_ID,
  USER_ID,
  WINE_ID,
  getRequest,
  makeSupabase,
  postRequest,
  subjectSeed,
} from "./route.test-helpers";

const mockRequireMembership = vi.fn();
const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { GET } = await import("./route");
const { POST } = await import("./accept/route");
const { POST: UNDO } = await import("./undo/route");

function allow(supabase: ReturnType<typeof makeSupabase>) {
  const auth = {
    supabase,
    restaurantId: RESTAURANT_ID,
    user: { id: USER_ID },
    role: "manager",
  };
  mockRequireMembership.mockResolvedValue(auth);
  mockRequireRole.mockResolvedValue(auth);
}

const actions = [
  {
    action_type: "place_bin",
    subject_table: "inventory_items",
    subject_id: INVENTORY_ID,
    patch: { bin_id: BIN_ID },
  },
  {
    action_type: "match_scan",
    subject_table: "invoice_scans",
    subject_id: SCAN_ID,
    patch: {
      line_index: 0,
      wine_id: WINE_ID,
      expected_line: { id: "line-1", name: "Before" },
    },
  },
] as const;

describe("reconcile queue routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET uses the membership gate and performs no query when denied", async () => {
    const supabase = makeSupabase({});
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "denied" }, { status: 401 }),
    );

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(mockRequireMembership).toHaveBeenCalledOnce();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("GET consumes scan inventory once and partitions duplicate, ambiguous, then unplaced stock", async () => {
    const scanId = SCAN_ID;
    const wines = [
      { id: "d-1", restaurant_id: RESTAURANT_ID, producer: "D", name: "Red", vintage: 2020, size_ml: 750, lineage_id: "lineage-d", lwin_id: null },
      { id: "d-2", restaurant_id: RESTAURANT_ID, producer: "D", name: "Red", vintage: 2020, size_ml: 750, lineage_id: "lineage-d", lwin_id: null },
      { id: "amb", restaurant_id: RESTAURANT_ID, producer: "A", name: "Amber", vintage: 2021, size_ml: 750, lineage_id: null, lwin_id: null },
      { id: "plain", restaurant_id: RESTAURANT_ID, producer: "P", name: "Plain", vintage: 2019, size_ml: 750, lineage_id: "lineage-p", lwin_id: null },
      { id: "scan-wine", restaurant_id: RESTAURANT_ID, producer: "S", name: "Scan", vintage: 2022, size_ml: 750, lineage_id: "lineage-s", lwin_id: null },
    ];
    const inventory = [
      { id: "d-old", restaurant_id: RESTAURANT_ID, wine_id: "d-1", invoice_scan_id: null, bin_id: null, quantity: 1, unit_cost: 9, format: "750ml", added_at: "2026-01-01" },
      { id: "d-new", restaurant_id: RESTAURANT_ID, wine_id: "d-1", invoice_scan_id: null, bin_id: null, quantity: 1, unit_cost: 11, format: "750ml", added_at: "2026-02-01" },
      { id: "d-two", restaurant_id: RESTAURANT_ID, wine_id: "d-2", invoice_scan_id: null, bin_id: BIN_ID, quantity: 3, unit_cost: 20, format: "750ml", added_at: "2026-01-01" },
      { id: "amb-i", restaurant_id: RESTAURANT_ID, wine_id: "amb", invoice_scan_id: null, bin_id: null, quantity: 4, unit_cost: 30, format: "750ml", added_at: "2026-01-01" },
      { id: "plain-i", restaurant_id: RESTAURANT_ID, wine_id: "plain", invoice_scan_id: null, bin_id: null, quantity: 1, unit_cost: 50, format: "750ml", added_at: "2026-01-01" },
      { id: "scan-i", restaurant_id: RESTAURANT_ID, wine_id: "scan-wine", invoice_scan_id: scanId, bin_id: BIN_ID, quantity: 2, unit_cost: 15, format: "750ml", added_at: "2026-01-01" },
    ];
    const line = { producer: "S", name: "Scan", vintage: 2022, qty: 2, unitCost: 15, format: "750ml" };
    const supabase = makeSupabase({
      wines,
      inventory_items: inventory,
      invoice_scans: [{
        id: scanId,
        restaurant_id: RESTAURANT_ID,
        distributor_name: "Supplier",
        final_line_items: [
          { id: "line-1", ...line },
          { id: "line-2", ...line },
          { id: "line-3", ...line, wine_id: "scan-wine" },
        ],
      }],
      bins: [
        { id: BIN_ID, restaurant_id: RESTAURANT_ID, code: "A-01", retired_at: null, priority: 1 },
        { id: "retired", restaurant_id: RESTAURANT_ID, code: "OLD", retired_at: "2026-01-01", priority: 9 },
      ],
      reconcile_batches: [{
        id: "99999999-9999-4999-8999-999999999999",
        restaurant_id: RESTAURANT_ID,
        action_count: 1,
        created_at: "2026-08-19",
        undone_at: null,
      }],
      reconcile_actions: [],
    });
    allow(supabase);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.issues.map((issue: { kind: string }) => issue.kind).sort()).toEqual([
      "ambiguous_lineage",
      "duplicate_suspect",
      "unmatched_scan",
      "unplaced",
    ]);
    expect(body.summary).toEqual({ itemCount: 4, unitCount: 12, atRisk: 255 });
    expect(body.issues.map((issue: { kind: string }) => issue.kind)).toEqual([
      "ambiguous_lineage",
      "duplicate_suspect",
      "unplaced",
      "unmatched_scan",
    ]);
    const duplicate = body.issues.find((issue: { kind: string }) => issue.kind === "duplicate_suspect");
    expect(duplicate).toMatchObject({
      atRisk: 55,
      units: 5,
      deepLink: "/cellar?wine=d-1",
    });
    expect(duplicate.action).toBeUndefined();
    expect(body.issues.find((issue: { kind: string }) =>
      issue.kind === "ambiguous_lineage").action).toBeUndefined();
    const unmatched = body.issues.find((issue: { kind: string }) => issue.kind === "unmatched_scan");
    expect(unmatched).toMatchObject({
      subjectId: `${SCAN_ID}:line-2`,
      units: 2,
      atRisk: 30,
      suggestion: {
        wineId: "scan-wine",
        basis: {
          kind: "field_match",
          fields: ["producer", "cuvee", "vintage", "format"],
        },
      },
      action: {
        type: "match_scan",
        targetId: SCAN_ID,
        payload: {
          line_index: 1,
          wine_id: "scan-wine",
          expected_line: { id: "line-2", ...line },
        },
      },
    });
    expect(body.issues.filter((issue: { kind: string }) => issue.kind === "unplaced")
      .map((issue: { subjectId: string }) => issue.subjectId)).toEqual(["plain-i"]);
    expect(body.bins.map((bin: { code: string }) => bin.code)).toEqual(["A-01"]);
    expect(body.latest_batch.id).toBe("99999999-9999-4999-8999-999999999999");
  });

  it("POST rejects mismatched action/table/patch shapes before database access", async () => {
    const supabase = makeSupabase({});
    allow(supabase);

    const response = await POST(postRequest("/api/reconcile-queue/accept", [{
      action_type: "place_bin",
      subject_table: "wines",
      subject_id: WINE_ID,
      patch: { lineage_id: LINEAGE_ID },
    }]));

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("POST rejects a lineage target outside the active restaurant", async () => {
    const seed = subjectSeed();
    const supabase = makeSupabase({
      ...seed,
      wine_lineages: [{
        id: LINEAGE_ID,
        restaurant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }],
    });
    allow(supabase);

    const response = await POST(postRequest("/api/reconcile-queue/accept", [{
      action_type: "link_lineage",
      subject_table: "wines",
      subject_id: WINE_ID,
      patch: { lineage_id: LINEAGE_ID },
    }]));

    expect(response.status).toBe(404);
    expect(supabase.tables.wines[0].lineage_id).toBeNull();
    expect(supabase.tables.reconcile_batches).toHaveLength(0);
  });

  it("POST refuses a manual lineage relink that the derivation trigger would overwrite", async () => {
    const supabase = makeSupabase(subjectSeed());
    allow(supabase);

    const response = await POST(postRequest("/api/reconcile-queue/accept", [{
      action_type: "link_lineage",
      subject_table: "wines",
      subject_id: WINE_ID,
      patch: { lineage_id: LINEAGE_ID },
    }]));

    expect(response.status).toBe(409);
    expect(supabase.tables.wines[0].lineage_id).toBeNull();
    expect(supabase.tables.reconcile_batches).toHaveLength(0);
  });

  it("bulk accept records full snapshots and undo restores every subject byte-for-byte", async () => {
    const supabase = makeSupabase(subjectSeed());
    allow(supabase);
    const before = {
      inventory: structuredClone(supabase.tables.inventory_items[0]),
      scan: structuredClone(supabase.tables.invoice_scans[0]),
      wine: structuredClone(supabase.tables.wines[0]),
    };

    const accepted = await POST(postRequest("/api/reconcile-queue/accept", actions));
    expect(accepted.status).toBe(201);
    const { batch } = await accepted.json();
    expect(supabase.tables.inventory_items[0]).toMatchObject({
      bin_id: BIN_ID,
      bin_location: "A-01",
    });
    expect(supabase.tables.invoice_scans[0].final_line_items).toEqual([
      { id: "line-1", name: "Before", wine_id: WINE_ID },
    ]);
    expect(supabase.tables.reconcile_actions).toHaveLength(2);
    expect(supabase.tables.reconcile_actions[0].prior_state).toEqual(before.inventory);
    expect(supabase.tables.reconcile_actions[0].new_state).toEqual(
      supabase.tables.inventory_items[0],
    );

    const undone = await UNDO(postRequest("/api/reconcile-queue/undo", {
      batch_id: batch.id,
    }));

    expect(undone.status).toBe(200);
    expect(supabase.tables.inventory_items[0]).toEqual(before.inventory);
    expect(supabase.tables.invoice_scans[0]).toEqual(before.scan);
    expect(supabase.tables.wines[0]).toEqual(before.wine);
    expect(supabase.tables.reconcile_batches[0]).toMatchObject({
      undone_by: USER_ID,
    });
    expect(supabase.tables.reconcile_batches[0].undone_at).toEqual(
      expect.any(String),
    );
  });

  it("bulk accept applies multiple unmatched lines from one scan and undo reverses them", async () => {
    const seed = subjectSeed();
    seed.invoice_scans[0].final_line_items = [
      { id: "line-1", name: "First" },
      { id: "line-2", name: "Second" },
    ];
    const supabase = makeSupabase(seed);
    allow(supabase);
    const before = structuredClone(supabase.tables.invoice_scans[0]);
    const scanActions = [0, 1].map((lineIndex) => ({
      action_type: "match_scan" as const,
      subject_table: "invoice_scans" as const,
      subject_id: SCAN_ID,
      patch: {
        line_index: lineIndex,
        wine_id: WINE_ID,
        expected_line: seed.invoice_scans[0].final_line_items[lineIndex],
      },
    }));

    const response = await POST(postRequest("/api/reconcile-queue/accept", scanActions));

    expect(response.status).toBe(201);
    const { batch } = await response.json();
    expect(supabase.tables.invoice_scans[0].final_line_items).toEqual([
      { id: "line-1", name: "First", wine_id: WINE_ID },
      { id: "line-2", name: "Second", wine_id: WINE_ID },
    ]);
    expect(supabase.tables.reconcile_actions).toHaveLength(2);

    const undone = await UNDO(postRequest("/api/reconcile-queue/undo", {
      batch_id: batch.id,
    }));
    expect(undone.status).toBe(200);
    expect(supabase.tables.invoice_scans[0]).toEqual(before);
  });

  it("match accept refuses a scan line that changed after the queue loaded", async () => {
    const supabase = makeSupabase(subjectSeed());
    allow(supabase);
    const stale = {
      ...actions[1],
      patch: { ...actions[1].patch, expected_line: { id: "line-1", name: "Stale" } },
    };

    const response = await POST(postRequest("/api/reconcile-queue/accept", [stale]));

    expect(response.status).toBe(409);
    expect(supabase.tables.invoice_scans[0].final_line_items).toEqual([
      { id: "line-1", name: "Before" },
    ]);
    expect(supabase.tables.reconcile_batches).toHaveLength(0);
  });

  it("undo preflights all subjects and reports conflicts without partial restoration", async () => {
    const supabase = makeSupabase(subjectSeed());
    allow(supabase);
    const accepted = await POST(postRequest("/api/reconcile-queue/accept", actions));
    const { batch } = await accepted.json();
    const acceptedInventory = structuredClone(supabase.tables.inventory_items[0]);
    supabase.tables.invoice_scans[0].status = "concurrent-edit";

    const response = await UNDO(postRequest("/api/reconcile-queue/undo", {
      batch_id: batch.id,
    }));

    expect(response.status).toBe(409);
    expect((await response.json()).error.details).toEqual({
      conflicts: [{ subject_table: "invoice_scans", subject_id: SCAN_ID }],
    });
    expect(supabase.tables.inventory_items[0]).toEqual(acceptedInventory);
    expect(supabase.tables.reconcile_batches[0].undone_at).toBeNull();
  });

  it("all subject and ledger queries carry the active restaurant scope", async () => {
    const supabase = makeSupabase(subjectSeed());
    allow(supabase);

    await POST(postRequest("/api/reconcile-queue/accept", actions));

    for (const table of ["bins", "inventory_items", "invoice_scans"]) {
      expect(supabase.operations[table]).toContainEqual([
        "eq",
        "restaurant_id",
        RESTAURANT_ID,
      ]);
    }
    for (const table of ["reconcile_batches", "reconcile_actions"]) {
      expect(JSON.stringify(supabase.operations[table])).toContain(RESTAURANT_ID);
    }
  });
});
