import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns tenant-scoped inventory rows and the aggregate totals derived from them. */
export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireCapability("cellar:view");
    if (auth instanceof NextResponse) return auth;

    const { data, error } = await auth.supabase
      .from("inventory_items")
      .select("*, wines(id, name, producer, vintage, varietal, region)")
      .eq("restaurant_id", auth.restaurantId)
      .order("added_at", { ascending: false });
    if (error) throw error;

    const items = data ?? [];
    return NextResponse.json({
      items,
      totalBottles: items.reduce((total, item) => total + item.quantity, 0),
      totalValue: items.reduce(
        (total, item) => total + item.quantity * item.unit_cost,
        0,
      ),
    });
  });
}
