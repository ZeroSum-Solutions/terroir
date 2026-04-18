import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) {
    return NextResponse.json(
      { error: "No restaurant membership found." },
      { status: 403 },
    );
  }

  // Fetch inventory items with bin_location and wine info
  const { data: items, error } = await supabase
    .from("inventory_items")
    .select("bin_location, quantity, wines(id, name, producer, vintage)")
    .eq("restaurant_id", membership.restaurant_id)
    .not("bin_location", "is", null);

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch grid data." },
      { status: 500 },
    );
  }

  // Group by bin_location
  const grid: Record<
    string,
    {
      wines: Array<{
        wineId: string;
        name: string;
        producer: string;
        vintage: number | null;
        quantity: number;
      }>;
      totalBottles: number;
    }
  > = {};

  for (const item of items ?? []) {
    if (!item.bin_location) continue;

    const bin = item.bin_location.toUpperCase().trim();
    const wine = item.wines as {
      id: string;
      name: string;
      producer: string;
      vintage: number | null;
    } | null;

    if (!wine) continue;

    if (!grid[bin]) {
      grid[bin] = { wines: [], totalBottles: 0 };
    }

    grid[bin].wines.push({
      wineId: wine.id,
      name: wine.name,
      producer: wine.producer,
      vintage: wine.vintage,
      quantity: item.quantity,
    });
    grid[bin].totalBottles += item.quantity;
  }

  return NextResponse.json(grid);
}
