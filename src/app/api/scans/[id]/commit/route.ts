import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import {
  ScanIdParamsSchema,
  ScanLineItemsSchema,
} from "@/lib/scanner/request-schemas";

export const runtime = "nodejs";

function reportBestEffort(error: unknown) {
  try {
    Sentry.captureException(error);
  } catch {}
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ScanIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: scan, error: fetchError } = await supabase
      .from("invoice_scans")
      .select("id, final_line_items")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .single();
    if (fetchError && (fetchError as { code?: string }).code !== "PGRST116") {
      throw fetchError;
    }
    if (!scan) return Errors.notFound("Scan");

    const parsedItems = ScanLineItemsSchema.safeParse(scan.final_line_items);
    if (!parsedItems.success) {
      return Errors.badRequest("Scan has no valid line items to commit.");
    }
    const items = parsedItems.data;

    // C15 (db audit 2026-08-23): claim this scan atomically before doing
    // any wine/inventory work. A plain sequential retry (client timeout,
    // reload, double-click) previously re-ran the whole insert with no
    // guard at all, doubling real inventory quantities. 0 rows claimed
    // means another commit already succeeded (or is in flight) for this
    // scan — reject before touching wines or inventory, not after.
    const { data: claimedRows, error: claimError } = await supabase
      .from("invoice_scans")
      .update({ committed_at: new Date().toISOString() } as never)
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .is("committed_at", null)
      .select("id");
    if (claimError) throw claimError;
    if (!claimedRows || claimedRows.length === 0) {
      return Errors.conflict(
        "scan_already_committed",
        "This scan has already been committed to inventory.",
      );
    }

    try {
      const winesPayload = items.map((item) => ({
        name: item.name,
        producer: item.producer,
        vintage: item.vintage,
        varietal: item.varietal || null,
        region: item.region || null,
        country: null,
        size_ml: 750,
      }));
      const { data: wineIdArray, error: batchError } = await supabase.rpc(
        "find_or_create_wines_batch",
        { p_restaurant_id: restaurantId, p_wines: winesPayload },
      );
      if (batchError) throw batchError;
      const parsedWineIds = z
        .array(z.string().uuid())
        .length(items.length)
        .safeParse(wineIdArray);
      if (!parsedWineIds.success) {
        throw new Error("find_or_create_wines_batch returned invalid IDs");
      }
      const wineIds = parsedWineIds.data;

      const inventoryInserts = items.map((item, index) => ({
        wine_id: wineIds[index],
        restaurant_id: restaurantId,
        invoice_scan_id: id,
        quantity: item.qty,
        unit_cost: item.unitCost,
        format: item.format ?? null,
        currency: item.currency ?? null,
        added_via: "invoice_scan" as const,
      }));
      const { error: inventoryError } = await supabase
        .from("inventory_items")
        .insert(inventoryInserts);
      if (inventoryError) {
        Sentry.captureException(inventoryError, {
          tags: { surface: "scan-commit", phase: "inventory_items-insert" },
          extra: { restaurantId, scanId: id, rowCount: inventoryInserts.length },
        });
        throw inventoryError;
      }

      try {
        void Promise.resolve(
          supabase.rpc("match_lwin_batch", { p_wine_ids: wineIds }),
        ).then(({ error }) => {
          if (error) reportBestEffort(error);
        }).catch(reportBestEffort);
      } catch (error) {
        reportBestEffort(error);
      }

      return NextResponse.json({
        scanId: id,
        itemCount: items.length,
        wineCount: new Set(wineIds).size,
      });
    } catch (error) {
      // Release the claim so a genuinely failed attempt (transient RPC
      // error, network blip) can still be retried — only a call that
      // actually produced inventory rows should stay permanently fenced.
      // Best-effort: if the release itself fails, the original error is
      // what the caller needs to see, not a masked cleanup failure.
      try {
        await supabase
          .from("invoice_scans")
          .update({ committed_at: null } as never)
          .eq("id", id)
          .eq("restaurant_id", restaurantId);
      } catch {}
      throw error;
    }
  });
}
