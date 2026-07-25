import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseParams } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";

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
    const { id } = parsedParams.data;

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/wines/{param}/overpaid",
      payload: { id },
      releaseOnError: false,
      handler: async () => {
        const { data: wine, error: fetchError } = await supabase
          .from("wines")
          .select("id, overpaid_flag")
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

        const overpaidFlag = !wine.overpaid_flag;
        const { data: updated, error } = await supabase
          .from("wines")
          .update({ overpaid_flag: overpaidFlag })
          .eq("id", id)
          .eq("restaurant_id", restaurantId)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!updated) {
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
          body: { wineId: id, overpaid_flag: overpaidFlag },
        };
      },
    });
  });
}
