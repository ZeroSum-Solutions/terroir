import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
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
    const auth = await requireMembership({ rateLimit: "mutation" });
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ScanIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const id = parsedParams.data.id.toLowerCase();

    const parsed = await parseJson(request, UpdateScanBodySchema);
    if (!parsed.ok) return parsed.response;
    const { items, edits } = parsed.data;

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/scans/{param}",
      payload: { id, body: { items, edits } },
      releaseOnError: false,
      handler: async () => {
        const { data: scan, error: fetchError } = await supabase
          .from("invoice_scans")
          .select("id")
          .eq("id", id)
          .eq("restaurant_id", restaurantId)
          .single();
        if (
          fetchError &&
          (fetchError as { code?: string }).code !== "PGRST116"
        ) {
          throw fetchError;
        }
        if (!scan) {
          return {
            status: 404,
            body: {
              error: { code: "not_found", message: "Scan not found." },
            },
          };
        }

        const { error: updateError } = await supabase
          .from("invoice_scans")
          .update({
            final_line_items: JSON.parse(JSON.stringify(items)) as Json,
            edits: JSON.parse(JSON.stringify(edits)) as Json,
            item_count: items.length,
            accuracy_score: Math.max(
              0,
              (
                items.length * SCORED_FIELDS.length -
                Object.keys(edits).length
              ) /
                (items.length * SCORED_FIELDS.length),
            ),
          })
          .eq("id", id)
          .eq("restaurant_id", restaurantId);
        if (updateError) throw updateError;

        return {
          status: 200,
          body: { success: true, itemCount: items.length },
        };
      },
    });
  });
}
