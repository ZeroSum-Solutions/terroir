import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { enrichRestaurantBatch } from "@/lib/wine-intelligence/batch";

export const runtime = "nodejs";

export async function POST() {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage", {
      rateLimit: "expensive",
    });
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const result = await enrichRestaurantBatch({ supabase, restaurantId });
    if (result.error) return Errors.internal();
    return NextResponse.json(result);
  });
}
