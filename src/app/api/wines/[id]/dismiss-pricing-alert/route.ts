import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  AlertDaysBodySchema,
  WineIdParamsSchema,
} from "@/lib/api/wine-mutation-schemas";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage");
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, AlertDaysBodySchema, {
      allowEmpty: true,
    });
    if (!parsedBody.ok) return parsedBody.response;
    const { id } = parsedParams.data;
    const days = parsedBody.data.days ?? 30;

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId:
        "api:POST:/api/wines/{param}/dismiss-pricing-alert",
      payload: { id, body: { days } },
      releaseOnError: false,
      handler: async () => {
        const { data: wine, error: fetchError } = await supabase
          .from("wines")
          .select("id")
          .eq("id", id)
          .eq("restaurant_id", restaurantId)
          .maybeSingle();
        if (fetchError) throw fetchError;
        if (!wine) {
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

        if (days === 0) {
          const { data: cleared, error } = await supabase
            .from("wines")
            .update({ pricing_dismissed_until: null })
            .eq("id", id)
            .eq("restaurant_id", restaurantId)
            .select("id")
            .maybeSingle();
          if (error) throw error;
          if (!cleared) {
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
              wineId: id,
              dismissedUntil: null,
              days,
            },
          };
        }

        const { data: until, error } = await supabase.rpc(
          "dismiss_pricing_alert",
          { p_wine_id: id, p_days: days },
        );
        if (error) throw error;
        if (!until) {
          throw new Error("dismiss pricing RPC returned no timestamp");
        }

        return {
          status: 200,
          body: {
            wineId: id,
            dismissedUntil: until,
            days,
          },
        };
      },
    });
  });
}
