import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

const BodySchema = z.object({
  wine_id: z.string().uuid(),
  kind: z.enum(["comp", "adjustment"]),
  bottles: z.number().int().safe().optional(),
  ml: z.number().int().safe().optional(),
  reason_code_id: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
}).refine((body) => (body.bottles ?? 0) !== 0 || (body.ml ?? 0) !== 0, {
  message: "A non-zero bottle or ml quantity is required.",
});

/**
 * POST /api/stock-adjustments
 *
 * Event-only in v1: this records the audit trail and does not mutate inventory.
 * Attribution always comes from the authenticated session; unknown client fields
 * are stripped by the boundary schema and never influence acting_user_id.
 */
export async function POST(request: NextRequest) {
  return withApiHandler(() => postStockAdjustment(request));
}

async function postStockAdjustment(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const parsed = await parseJson(request, BodySchema, { message: "Invalid body." });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const [{ data: wine, error: wineError }, { data: reason, error: reasonError }] =
    await Promise.all([
      auth.supabase
        .from("wines")
        .select("id")
        .eq("id", body.wine_id)
        .eq("restaurant_id", auth.restaurantId)
        .maybeSingle(),
      auth.supabase
        .from("reason_codes")
        .select("id")
        .eq("id", body.reason_code_id)
        .eq("restaurant_id", auth.restaurantId)
        .eq("active", true)
        .maybeSingle(),
    ]);
  if (wineError) throw wineError;
  if (reasonError) throw reasonError;
  if (!wine) return Errors.notFound("Wine");
  if (!reason) {
    return Errors.unprocessable(
      "invalid_reason_code",
      "Reason code must be active for this restaurant.",
    );
  }

  const { data, error } = await auth.supabase
    .from("stock_adjustments")
    .insert({
      restaurant_id: auth.restaurantId,
      wine_id: body.wine_id,
      kind: body.kind,
      bottles: body.bottles ?? 0,
      ml: body.ml ?? 0,
      reason_code_id: body.reason_code_id,
      note: body.note ?? null,
      acting_user_id: auth.user.id,
    })
    .select("id, kind, bottles, ml, reason_code_id, note, created_at")
    .single();
  if (error) throw error;

  return NextResponse.json({ adjustment: data }, { status: 201 });
}
