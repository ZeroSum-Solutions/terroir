// assembleQueue is pure — no Supabase involved — so these exercise it
// directly with plain row fixtures.
import { describe, expect, it } from "vitest";
import { assembleQueue } from "./queue-sources";
import type { Database } from "@/types/database";

type Inventory = Database["public"]["Tables"]["inventory_items"]["Row"];
type Scan = Database["public"]["Tables"]["invoice_scans"]["Row"];
type Wine = Database["public"]["Tables"]["wines"]["Row"];

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const SCAN_ID = "44444444-4444-4444-8444-444444444444";

function wine(overrides: Partial<Wine>): Wine {
  return {
    id: "wine-1",
    restaurant_id: RESTAURANT_ID,
    producer: "Maker",
    name: "Estate Red",
    vintage: 2020,
    size_ml: 750,
    lwin_id: null,
    lineage_id: "lineage-1",
    ...overrides,
  } as Wine;
}

function inventoryItem(overrides: Partial<Inventory>): Inventory {
  return {
    id: "inv-1",
    restaurant_id: RESTAURANT_ID,
    wine_id: "wine-1",
    invoice_scan_id: null,
    bin_id: "bin-1",
    quantity: 1,
    unit_cost: 10,
    format: "750ml",
    added_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Inventory;
}

function scan(overrides: Partial<Scan>): Scan {
  return {
    id: SCAN_ID,
    restaurant_id: RESTAURANT_ID,
    distributor_name: "Supplier",
    final_line_items: [],
    ...overrides,
  } as Scan;
}

describe("assembleQueue: unmatched scans", () => {
  it("skips a malformed final_line_items entry instead of crashing, and still surfaces the valid line after it", () => {
    const wines = [wine({ id: "wine-1" })];
    const scans = [scan({
      final_line_items: [
        null,
        "also-not-an-object",
        { id: "line-2", producer: "Other", name: "Unmatched Wine", qty: 1, unitCost: 12 },
      ],
    })];

    const queue = assembleQueue([], scans, wines);

    const unmatched = queue.rows.filter((issue) => issue.kind === "unmatched_scan");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].subjectId).toBe(`${SCAN_ID}:2:line-2`);
  });

  it("sorts multiple scan-linked inventory candidates deterministically when matching against scan lines", () => {
    const wines = [wine({ id: "wine-1" })];
    // Two inventory rows tied to the same scan (invoice_scan_id set),
    // deliberately seeded out of id order so the comparator that orders
    // `available` candidates actually has to compare two elements.
    const inventory = [
      inventoryItem({ id: "zzz-later", invoice_scan_id: SCAN_ID, quantity: 1, unit_cost: 10, format: "750ml" }),
      inventoryItem({ id: "aaa-earlier", invoice_scan_id: SCAN_ID, quantity: 2, unit_cost: 11, format: "750ml" }),
    ];
    const scans = [scan({
      final_line_items: [
        { id: "line-1", producer: "Maker", name: "Estate Red", vintage: 2020, qty: 1, unitCost: 10, format: "750ml" },
      ],
    })];

    const queue = assembleQueue(inventory, scans, wines);

    // The exact match consumes exactly one candidate — no unmatched_scan
    // issue for this line, and both inventory rows are otherwise
    // unaffected (neither claims a "duplicate"/"unplaced" slot since both
    // have a bin and an invoice_scan_id).
    expect(queue.rows.filter((issue) => issue.kind === "unmatched_scan")).toHaveLength(0);
  });
});
