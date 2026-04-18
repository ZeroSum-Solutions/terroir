import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateToastCsv } from "@/lib/export/toast-csv";

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

  const rid = membership.restaurant_id;

  // Fetch wines with their latest wine list prices (if any)
  const { data: wines } = await supabase
    .from("wines")
    .select("id, name, producer, vintage, varietal")
    .eq("restaurant_id", rid)
    .order("producer")
    .order("name");

  if (!wines || wines.length === 0) {
    return NextResponse.json(
      { error: "No wines found." },
      { status: 404 },
    );
  }

  // Get wine list item prices for these wines
  const wineIds = wines.map((w) => w.id);
  const { data: listItems } = await supabase
    .from("wine_list_items")
    .select("wine_id, bottle_price")
    .in("wine_id", wineIds);

  // Map wine_id to best bottle_price (highest, since that's the menu price)
  const priceMap = new Map<string, number>();
  for (const item of listItems ?? []) {
    if (item.bottle_price != null) {
      const existing = priceMap.get(item.wine_id);
      if (existing == null || item.bottle_price > existing) {
        priceMap.set(item.wine_id, item.bottle_price);
      }
    }
  }

  const rows = wines.map((w) => ({
    name: w.name,
    producer: w.producer,
    vintage: w.vintage,
    varietal: w.varietal,
    bottlePrice: priceMap.get(w.id) ?? null,
  }));

  const csv = generateToastCsv(rows);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="toast-import.csv"',
    },
  });
}
