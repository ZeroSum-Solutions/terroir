import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership, requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  ScanIdParamsSchema,
  UpdateScanBodySchema,
} from "@/lib/scanner/request-schemas";
import { SCORED_FIELDS } from "@/lib/scanner/scored-fields";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

export async function PATCH(
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

    const parsed = await parseJson(request, UpdateScanBodySchema);
    if (!parsed.ok) return parsed.response;
    const { items, edits } = parsed.data;

    const { data: scan, error: fetchError } = await supabase
      .from("invoice_scans")
      .select("id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .single();
    if (fetchError && (fetchError as { code?: string }).code !== "PGRST116") {
      throw fetchError;
    }
    if (!scan) return NextResponse.json(
      { error: { code: "not_found", message: "Scan not found." } },
      { status: 404 },
    );

    const { error: updateError } = await supabase
      .from("invoice_scans")
      .update({
        final_line_items: JSON.parse(JSON.stringify(items)) as Json,
        edits: JSON.parse(JSON.stringify(edits)) as Json,
        item_count: items.length,
        accuracy_score: Math.max(
          0,
          (items.length * SCORED_FIELDS.length - Object.keys(edits).length) /
            (items.length * SCORED_FIELDS.length),
        ),
      })
      .eq("id", id)
      .eq("restaurant_id", restaurantId);
    if (updateError) throw updateError;

    return NextResponse.json({ success: true, itemCount: items.length });
  });
}

/**
 * DELETE /api/scans/[id] — SCAN-04 / decision D6.
 *
 * The FIRST delete handler this product has had for a scan or an invoice.
 * Deleting an invoice whose lines already reached inventory reverses that
 * inventory FIRST — see `delete_invoice_scan` (migration 0143) for why
 * that is one RPC and not `revert_import_batch` (0109), which only knows
 * how to walk `import_batch_rows`.
 *
 * Manager-scoped at both layers: `requireRole` here for a clean 403, and
 * the DELETE policy + the RPC's own `is_member_with_role` check in the
 * database, because an API-level role check is not a tenancy boundary.
 */
const DeleteResultSchema = z.object({
  scanId: z.string(),
  inventoryRowsDeleted: z.number().int().nonnegative(),
  bottlesRemoved: z.number().int().nonnegative(),
});

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase } = auth;

    const parsedParams = await parseParams(params, ScanIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;

    const { data, error } = await supabase.rpc("delete_invoice_scan", {
      p_scan_id: parsedParams.data.id,
    });

    if (error) {
      const code = (error as { code?: string }).code;
      // P0002: RLS already narrowed the lookup to scans this session can
      // read, so another tenant's id is indistinguishable from a missing
      // one — which is the point.
      if (code === "P0002") return Errors.notFound("Scan");
      if (code === "P0003") {
        return Errors.forbidden("Only an owner or manager can delete an invoice.");
      }
      throw error;
    }

    const parsedResult = DeleteResultSchema.safeParse(data);
    if (!parsedResult.success) throw new Error("delete_invoice_scan returned an unexpected shape");

    return NextResponse.json(parsedResult.data);
  });
}
