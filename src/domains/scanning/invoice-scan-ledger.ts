// SCAN-04 / T2 — one invoice, one ledger row.
//
// THE DEFECT THIS FIXES. POST /api/scan creates an `invoice_scans` row for
// every extraction (invoice-scan-service.ts:82-95, and again on the
// JSON-body path in /api/scan/route.ts:189-203). The "Save to Inventory"
// button then called POST /api/inventory/save-scan, which INSERTED A
// SECOND, INDEPENDENT ROW for the same invoice and never linked the two.
// So the /scan → results → save flow left an orphan extraction row in the
// ledger on every single use, while POST /api/scans/[id]/commit — the
// other path into inventory — already did the right thing and UPDATED the
// existing row with an atomic `committed_at` claim
// (src/app/api/scans/[id]/commit/route.ts:57-69).
//
// This module is that claim, shared. save-scan now takes the same route
// commit does when it knows which row it belongs to, and falls back to the
// insert ONLY when it genuinely has no prior row — which is a real case,
// not a legacy one: the scanner's manual-entry flow (`enterManualEntry` in
// scanner.tsx) builds a Scan from nothing and never touches /api/scan.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineItem, Scan } from "@/lib/scanner/types";
import type { Database, Json } from "@/types/database";

export type LedgerRowResult =
  | { ok: true; scanId: string; created: boolean }
  | { ok: false; status: number; body: unknown };

/**
 * Parse an invoice date string into an ISO date or null. Accepts ISO
 * strings ("2024-03-15"), slash-delimited ("03/15/2024"), and gracefully
 * returns null for placeholder values like "—".
 */
export function parseInvoiceDate(raw: string): string | null {
  if (!raw || raw === "—" || raw === "-") return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function settledPayload(scan: Scan, originalItems: LineItem[], accuracyScore: number) {
  return {
    distributor_name: scan.source.distributor,
    invoice_number: scan.source.invoiceNo === "—" ? null : scan.source.invoiceNo,
    invoice_date: parseInvoiceDate(scan.source.invoiceDate),
    parsed_line_items: JSON.parse(JSON.stringify(originalItems)) as Json,
    final_line_items: JSON.parse(JSON.stringify(scan.items)) as Json,
    edits: JSON.parse(JSON.stringify(scan.edits)) as Json,
    accuracy_score: accuracyScore,
    item_count: scan.items.length,
    // Arithmetic reconciled (or had nothing to check) by this point — the
    // row is a settled, human-confirmed record, not an in-flight one.
    status: "complete",
    // Whatever reason the extraction recorded (a review flag, an empty
    // first pass) has been resolved by the human who is saving it now.
    status_reason: null,
  };
}

/**
 * Claim the ledger row this save belongs to, creating one only when the
 * caller has none.
 *
 * When `scan.scanId` is present the row is claimed with the SAME atomic
 * compare-and-swap POST /api/scans/[id]/commit uses: a fenced update on
 * `committed_at IS NULL` that returns zero rows if another save (or a
 * commit) already claimed it. That fence is what makes a double-tap, a
 * client timeout retry with a fresh idempotency key, or a commit racing a
 * save fail loudly at 409 instead of inserting inventory twice.
 */
export async function claimOrCreateInvoiceScanRow(opts: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  scan: Scan;
  originalItems: LineItem[];
  accuracyScore: number;
}): Promise<LedgerRowResult> {
  const { supabase, restaurantId, scan, originalItems, accuracyScore } = opts;
  const payload = settledPayload(scan, originalItems, accuracyScore);

  if (!scan.scanId) {
    // The fence this function exists to enforce is `committed_at IS NULL`
    // (see the update branch below). `committed_at` has no column default
    // (0090), so a row inserted without it is born with the fence disarmed —
    // any later call carrying this id would pass `.is("committed_at", null)`
    // and claim it again. This is a freshly-settled row, so it is claimed at
    // creation, the same as the update branch claims an existing one.
    const { data, error } = await supabase
      .from("invoice_scans")
      .insert({
        restaurant_id: restaurantId,
        ...payload,
        committed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, status: 500, body: { error, scanId: null } };
    return { ok: true, scanId: data.id, created: true };
  }

  const { data: claimed, error: claimError } = await supabase
    .from("invoice_scans")
    .update({ ...payload, committed_at: new Date().toISOString() } as never)
    .eq("id", scan.scanId)
    .eq("restaurant_id", restaurantId)
    .is("committed_at", null)
    .select("id");
  if (claimError) return { ok: false, status: 500, body: { error: claimError, scanId: scan.scanId } };

  if (claimed && claimed.length > 0) {
    return { ok: true, scanId: claimed[0].id, created: false };
  }

  // Zero rows means one of exactly two things, and they are different
  // answers to the caller: the scan is not ours/does not exist (404), or
  // it exists and something already committed it (409).
  const { data: existing } = await supabase
    .from("invoice_scans")
    .select("id")
    .eq("id", scan.scanId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  return existing
    ? {
        ok: false,
        status: 409,
        body: {
          error: {
            code: "scan_already_committed",
            message: "This scan has already been saved to inventory.",
          },
        },
      }
    : {
        ok: false,
        status: 404,
        body: { error: { code: "not_found", message: "Scan not found." } },
      };
}

/**
 * D6 rule 1 — "nothing vanishes on its own". When the inventory write
 * fails after the ledger row was claimed, the row STAYS: it is a real
 * record that a real extraction happened. What changes is that it states
 * why nothing reached inventory, and gives up its `committed_at` claim so
 * the operator can simply save again.
 *
 * This deliberately replaces the two `invoice_scans.delete()` rollbacks
 * save-scan used to run (route.ts:262 and :291 before this change). Those
 * were silent no-ops — `invoice_scans` had no DELETE policy at all until
 * migration 0143 — so they never actually removed anything; but even
 * working, a delete here is precisely the disappearing-row behaviour D6
 * forbids.
 */
export async function markInvoiceScanSaveFailed(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  scanId: string,
): Promise<void> {
  await supabase
    .from("invoice_scans")
    .update({ status_reason: "inventory_save_failed", committed_at: null } as never)
    .eq("id", scanId)
    .eq("restaurant_id", restaurantId);
}
