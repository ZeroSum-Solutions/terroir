import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireMembership } from "@/lib/api/auth";
import {
  isValidIdempotencyKey,
  withIdempotency,
} from "@/lib/api/idempotency";
import { SCORED_FIELDS } from "@/lib/scanner/scored-fields";
import type { LineItem, Scan } from "@/lib/scanner/types";
import type { Database, Json } from "@/types/database";

export const runtime = "nodejs";

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

  // ── Parse & validate body (FormData with optional file) ──────────
  let scan: Scan;
  let originalItems: LineItem[];
  let file: File | null = null;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid form data." },
        { status: 400 },
      );
    }
    try {
      const raw = formData.get("data");
      if (typeof raw !== "string") throw new Error("missing data field");
      const body = JSON.parse(raw) as SaveScanBody;
      scan = body.scan;
      originalItems = body.originalItems;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON in data field." },
        { status: 400 },
      );
    }
    const f = formData.get("file");
    if (f instanceof File && f.size > 0) file = f;
  } else {
    let body: SaveScanBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 },
      );
    }
    scan = body.scan;
    originalItems = body.originalItems;
  }

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

  // ── Idempotency (BND-006) ────────────────────────────────────────
  // The scanner client sends an Idempotency-Key UUID on every save
  // attempt and reuses it across network retries. A successful save
  // followed by a retry must return the original response WITHOUT
  // re-inserting inventory rows.
  const rawKey = request.headers.get("Idempotency-Key");
  const key = isValidIdempotencyKey(rawKey) ? rawKey : null;

  const result = await withIdempotency({
    supabase,
    restaurantId,
    key,
    handler: async () => saveScanOnce({
      supabase,
      restaurantId,
      scan,
      originalItems,
      file,
    }),
  });

  return NextResponse.json(result.body, { status: result.status });
}

/** The real save work. Extracted so `withIdempotency` can wrap it. */
async function saveScanOnce(opts: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  scan: Scan;
  originalItems: LineItem[];
  file: File | null;
}): Promise<{ status: number; body: unknown }> {
  const { supabase, restaurantId, scan, originalItems, file } = opts;

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
    Sentry.captureException(scanInsertError ?? new Error("invoiceScan null without error"), {
      tags: { surface: "save-scan", phase: "invoice_scans-insert" },
      extra: { restaurantId, itemCount: scan.items.length },
    });
    return { status: 500, body: { error: "Failed to save invoice scan." } };
  }

  const scanId = invoiceScan.id;

  // ── Upload invoice image to storage (non-blocking) ──────────────
  if (file) {
    try {
      const ext = file.type === "application/pdf" ? "pdf"
        : file.type === "image/png" ? "png"
        : "jpg";
      const storagePath = `${restaurantId}/${scanId}.${ext}`;
      const fileBuffer = Buffer.from(await file.arrayBuffer());
      // INT-016: `upsert: true` as defense-in-depth. In the current
      // retry flow a fresh scanId is generated per handler invocation
      // (line 177 `const scanId = invoiceScan.id;`), so the storage
      // path is unique per attempt and collision isn't possible in
      // practice. This flip is insurance against:
      //   - A future refactor that reuses scanId across retries
      //     (e.g. an idempotency RPC that caches the invoice_scans
      //     row and replays it).
      //   - Supabase Storage edge cases where a stale object appears
      //     to occupy a path (CDN / replication lag).
      // Negligible downside — `storage.objects` INSERT RLS still
      // gates the path prefix, so cross-tenant overwrite is blocked
      // regardless of the upsert flag.
      const { error: uploadError } = await supabase.storage
        .from("invoice-images")
        .upload(storagePath, fileBuffer, {
          contentType: file.type,
          upsert: true,
        });
      if (uploadError) {
        console.error("Invoice image upload failed:", uploadError);
        Sentry.captureException(uploadError, {
          tags: { surface: "save-scan", phase: "storage-upload" },
          extra: { scanId, contentType: file.type },
        });
      } else {
        await supabase
          .from("invoice_scans")
          .update({ raw_image_path: storagePath })
          .eq("id", scanId);
      }
    } catch (err) {
      console.error("Invoice image upload error:", err);
    }
  }

  // ── Create wines + inventory items ───────────────────────────────
  const winesPayload = scan.items.map((item) => ({
    name: item.name,
    producer: item.producer,
    vintage: item.vintage ?? null,
    varietal: item.varietal || null,
    region: item.region || null,
    country: null,
    size_ml: 750,
  }));

  const { data: wineIdArray, error: batchError } = await supabase.rpc(
    "find_or_create_wines_batch",
    {
      p_restaurant_id: restaurantId,
      p_wines: winesPayload,
    },
  );

  if (batchError || !wineIdArray) {
    console.error("find_or_create_wines_batch failed:", batchError);
    Sentry.captureException(batchError ?? new Error("wineIdArray null without error"), {
      tags: { surface: "save-scan", phase: "find_or_create_wines_batch" },
      extra: { restaurantId, wineCount: winesPayload.length, scanId },
    });
    await supabase.from("invoice_scans").delete().eq("id", scanId);
    return { status: 500, body: { error: "Failed to save wines." } };
  }

  const wineIds = new Set<string>(wineIdArray as string[]);

  const inventoryInserts = scan.items.map((item, idx) => ({
    wine_id: (wineIdArray as string[])[idx],
    restaurant_id: restaurantId,
    invoice_scan_id: scanId,
    quantity: item.qty,
    unit_cost: item.unitCost,
    added_via: "invoice_scan" as const,
  }));

  // Batch insert all inventory items
  const { error: inventoryError } = await supabase
    .from("inventory_items")
    .insert(inventoryInserts);

  if (inventoryError) {
    console.error("inventory_items insert failed:", inventoryError);
    Sentry.captureException(inventoryError, {
      tags: { surface: "save-scan", phase: "inventory_items-insert" },
      extra: { restaurantId, scanId, rowCount: inventoryInserts.length },
    });
    // Roll back: delete the invoice_scans row so the user can retry
    await supabase.from("invoice_scans").delete().eq("id", scanId);
    return { status: 500, body: { error: "Failed to save inventory items." } };
  }

  // LWIN matching — fire-and-forget, non-blocking on the response.
  // INT-017: failures now capture to Sentry so a systemic LWIN outage
  // surfaces. Still fire-and-forget — the main save has succeeded.
  const wineIdStrings = wineIdArray as string[];
  supabase
    .rpc("match_lwin_batch", { p_wine_ids: wineIdStrings })
    .then(({ data, error: lwinError }) => {
      if (lwinError) {
        console.error("LWIN batch match failed:", lwinError);
        Sentry.captureException(lwinError, {
          tags: { surface: "lwin-match", phase: "match_lwin_batch-rpc", path: "save-scan" },
          extra: { wineIdCount: wineIdStrings.length },
        });
      } else if (data) {
        console.log(`LWIN matched ${data.length} of ${wineIdStrings.length} wines`);
      }
    });

  /**
   * Response count semantics (DEBT-004 / BND-028):
   * - `itemCount` = number of inventory rows inserted, which equals the
   *   number of line items on the invoice (scan.items.length). One line
   *   item → one inventory_items row, regardless of qty.
   * - `wineCount` = number of DISTINCT wines referenced by those rows,
   *   i.e. the cardinality of the set of wine_ids returned by
   *   find_or_create_wines_batch. This count does NOT distinguish
   *   newly-created wines from wines already in the catalog — it's
   *   "how many unique SKUs are on this invoice", not "how many new
   *   wines were added". The UI copy in ready-view.tsx is phrased
   *   accordingly ("N items to inventory (M distinct wines)").
   */
  return {
    status: 200,
    body: {
      scanId,
      itemCount: scan.items.length,
      wineCount: wineIds.size,
    },
  };
}
