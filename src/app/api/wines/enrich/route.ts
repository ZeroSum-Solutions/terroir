import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { enrichRestaurantBatch } from "@/lib/wine-intelligence/batch";

export const runtime = "nodejs";

export async function POST() {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId, role } = auth;
    if (role !== "owner" && role !== "manager") {
      return Errors.forbidden(
        "Enriching wines requires owner or manager role.",
      );
    }

    const result = await enrichRestaurantBatch({ supabase, restaurantId });
    if (result.error) return Errors.internal();
    return NextResponse.json(result);
  });
}
