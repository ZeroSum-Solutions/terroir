import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  PricingTargetsBodySchema,
  WineIdParamsSchema,
} from "@/lib/api/wine-mutation-schemas";

export const runtime = "nodejs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage");
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

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

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/wines/{param}/pricing-targets",
      payload: { id, body: parsedBody.data },
      releaseOnError: false,
      handler: async () => {
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
        if (!data) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found",
                message: "Wine not found.",
              },
            },
          };
        }

        return {
          status: 200,
          body: {
            wineId: data.id,
            pour_cost_pct: data.pricing_target_pour_cost_pct,
            markup_ratio: data.pricing_target_markup_ratio,
          },
        };
      },
    });
  });
}
