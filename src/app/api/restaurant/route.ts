import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { UpdateRestaurantBodySchema } from "@/lib/api/restaurant-schemas";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

/** Returns the active restaurant's metadata. */
export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireCapability("restaurant:view");
    if (auth instanceof NextResponse) return auth;

    const { data, error } = await auth.supabase
      .from("restaurants")
      .select("*")
      .eq("id", auth.restaurantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ restaurant: null });

    return NextResponse.json({ restaurant: data });
  });
}

/** Updates metadata for the caller's active restaurant. */
export async function PATCH(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireCapability("restaurant:manage");
    if (auth instanceof NextResponse) return auth;

    const parsed = await parseJson(request, UpdateRestaurantBodySchema, {
      message: "Invalid body.",
    });
    if (!parsed.ok) return parsed.response;
    if (Object.keys(parsed.data).length === 0) {
      return Errors.badRequest("No valid fields.");
    }

    return idempotentMutationResponse({
      request,
      supabase: auth.supabase,
      restaurantId: auth.restaurantId,
      operationId: "api:PATCH:/api/restaurant",
      payload: parsed.data,
      releaseOnError: false,
      handler: async () => {
        const { error } = await auth.supabase
          .from("restaurants")
          .update(parsed.data)
          .eq("id", auth.restaurantId);
        if (error) throw error;

        return { status: 200, body: { ok: true } };
      },
    });
  });
}
