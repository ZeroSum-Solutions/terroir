import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  PricingTargetsBodySchema,
  WineIdParamsSchema,
} from "@/lib/api/wine-mutation-schemas";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId, role } = auth;
    if (role !== "owner" && role !== "manager") {
      return Errors.forbidden(
        "Setting pricing targets requires owner or manager role.",
      );
    }

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, PricingTargetsBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { id } = parsedParams.data;

    const update: {
      pricing_target_pour_cost_pct?: number | null;
      pricing_target_markup_ratio?: number | null;
    } = {};
    if ("pour_cost_pct" in parsedBody.data) {
      update.pricing_target_pour_cost_pct =
        parsedBody.data.pour_cost_pct ?? null;
    }
    if ("markup_ratio" in parsedBody.data) {
      update.pricing_target_markup_ratio =
        parsedBody.data.markup_ratio ?? null;
    }

    const { data, error } = await supabase
      .from("wines")
      .update(update)
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select(
        "id, pricing_target_pour_cost_pct, pricing_target_markup_ratio",
      )
      .maybeSingle();
    if (error) throw error;
    if (!data) return Errors.notFound("Wine");

    return NextResponse.json({
      wineId: data.id,
      pour_cost_pct: data.pricing_target_pour_cost_pct,
      markup_ratio: data.pricing_target_markup_ratio,
    });
  });
}
