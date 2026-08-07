import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";

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
