import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import type { LineItem, Scan } from "@/lib/scanner/types";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

/** Fields on a LineItem that count toward the accuracy score. */
const SCORED_FIELDS: (keyof LineItem)[] = [
  "name",
  "producer",
  "vintage",
  "varietal",
  "region",
  "qty",
  "unitCost",
];

type SaveScanBody = {
  scan: Scan;
  originalItems: LineItem[];
};

/**
 * Compute accuracy as the fraction of scorable fields that were NOT edited.
 *
 * Each item contributes `SCORED_FIELDS.length` total fields.
 * `scan.edits` is a Record<`${itemId}-${field}`, true> — one entry per
 * field the user corrected.
 */
function computeAccuracy(scan: Scan): number {
  const totalFields = scan.items.length * SCORED_FIELDS.length;
  if (totalFields === 0) return 1;

  const editedFields = Object.keys(scan.edits).length;
  return Math.max(0, (totalFields - editedFields) / totalFields);
}

/**
 * Parse an invoice date string into an ISO date or null.
 * Accepts ISO strings ("2024-03-15"), slash-delimited ("03/15/2024"),
 * and gracefully returns null for placeholder values like "—".
 */
function parseInvoiceDate(raw: string): string | null {
  if (!raw || raw === "—" || raw === "-") return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;

  // Return YYYY-MM-DD
  return date.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // ── Parse & validate body ────────────────────────────────────────
  let body: SaveScanBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { scan, originalItems } = body;

  if (!scan?.source || !Array.isArray(scan.items) || scan.items.length === 0) {
    return NextResponse.json(
      { error: "Request must include a scan with at least one item." },
      { status: 400 },
    );
  }

  if (!Array.isArray(originalItems)) {
    return NextResponse.json(
      { error: "Request must include originalItems array." },
      { status: 400 },
    );
  }

  // ── Accuracy score ───────────────────────────────────────────────
  const accuracyScore = computeAccuracy(scan);

  // ── Insert invoice_scans row ─────────────────────────────────────
  const { data: invoiceScan, error: scanInsertError } = await supabase
    .from("invoice_scans")
    .insert({
      restaurant_id: restaurantId,
      distributor_name: scan.source.distributor,
      invoice_number: scan.source.invoiceNo === "—" ? null : scan.source.invoiceNo,
      invoice_date: parseInvoiceDate(scan.source.invoiceDate),
      parsed_line_items: JSON.parse(JSON.stringify(originalItems)) as Json,
      final_line_items: JSON.parse(JSON.stringify(scan.items)) as Json,
      edits: JSON.parse(JSON.stringify(scan.edits)) as Json,
      accuracy_score: accuracyScore,
      item_count: scan.items.length,
    })
    .select("id")
    .single();

  if (scanInsertError || !invoiceScan) {
    console.error("invoice_scans insert failed:", scanInsertError);
    return NextResponse.json(
      { error: "Failed to save invoice scan." },
      { status: 500 },
    );
  }

  const scanId = invoiceScan.id;

  // ── Create wines + inventory items ───────────────────────────────
  const wineIds = new Set<string>();
  const inventoryInserts: Array<{
    wine_id: string;
    restaurant_id: string;
    invoice_scan_id: string;
    quantity: number;
    unit_cost: number;
    added_via: "invoice_scan";
  }> = [];

  for (const item of scan.items) {
    // find_or_create_wine returns the wine UUID
    const { data: wineId, error: rpcError } = await supabase.rpc(
      "find_or_create_wine",
      {
        p_restaurant_id: restaurantId,
        p_name: item.name,
        p_producer: item.producer,
        p_vintage: item.vintage ?? undefined,
        p_varietal: item.varietal || undefined,
        p_region: item.region || undefined,
      },
    );

    if (rpcError || !wineId) {
      console.error(
        `find_or_create_wine failed for "${item.name}":`,
        rpcError,
      );
      // Roll back: delete the invoice_scans row so the user can retry
      await supabase.from("invoice_scans").delete().eq("id", scanId);
      return NextResponse.json(
        { error: `Failed to save wine "${item.name}".` },
        { status: 500 },
      );
    }

    wineIds.add(wineId);

    inventoryInserts.push({
      wine_id: wineId,
      restaurant_id: restaurantId,
      invoice_scan_id: scanId,
      quantity: item.qty,
      unit_cost: item.unitCost,
      added_via: "invoice_scan",
    });
  }

  // Batch insert all inventory items
  const { error: inventoryError } = await supabase
    .from("inventory_items")
    .insert(inventoryInserts);

  if (inventoryError) {
    console.error("inventory_items insert failed:", inventoryError);
    // Roll back: delete the invoice_scans row so the user can retry
    await supabase.from("invoice_scans").delete().eq("id", scanId);
    return NextResponse.json(
      { error: "Failed to save inventory items." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    scanId,
    itemCount: scan.items.length,
    wineCount: wineIds.size,
  });
}
