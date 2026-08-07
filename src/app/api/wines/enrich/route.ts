import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { enrichRestaurantBatch } from "@/lib/wine-intelligence/batch";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage", {
      rateLimit: "expensive",
    });
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/wines/enrich",
      payload: {},
      releaseOnError: false,
      handler: async () => {
        const result = await enrichRestaurantBatch({ supabase, restaurantId });
        if (result.error) {
          return {
            status: 500,
            body: {
              error: {
                code: "internal_error",
                message: "Internal server error.",
              },
            },
          };
        }
        return { status: 200, body: result };
      },
    });
  });
}
