import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { generateToastCsv } from "@/lib/export/toast-csv";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

export async function GET() {
  return withApiHandler(getToastCsv);
}

async function getToastCsv() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  return streamToastCsv(auth.supabase, auth.restaurantId);
}

export async function streamToastCsv(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<NextResponse> {
  // Fetch wines with their latest wine list prices (if any)
  const { data: wines, error: winesError } = await supabase
    .from("wines")
    .select("id, name, producer, vintage, varietal")
    .eq("restaurant_id", restaurantId)
    .order("producer")
    .order("name");
  if (winesError) throw winesError;

  if (!wines || wines.length === 0) {
    const emptyCsv = generateToastCsv([]);
    return new NextResponse(emptyCsv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="toast-import.csv"',
      },
    });
  }

  // Get wine list item prices for these wines
  const wineIds = wines.map((w) => w.id);
  const { data: listItems, error: listItemsError } = await supabase
    .from("wine_list_items")
    .select("wine_id, bottle_price")
    .in("wine_id", wineIds);
  if (listItemsError) throw listItemsError;

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
