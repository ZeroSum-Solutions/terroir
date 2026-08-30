import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// ── Past drink window row type (#147) ─────────────────────────────────
export type PastDrinkWindowRow = {
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  drink_window_end: number | null;
  bottle_count: number;
  bin_location: string | null;
};

export async function fetchPastDrinkWindow(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<PastDrinkWindowRow[]> {
  const currentYear = new Date().getFullYear();

  const { data: wines, error: wineErr } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, drink_window_end",
    )
    .eq("restaurant_id", restaurantId)
    .eq("is_eightysixed", false)
    .not("drink_window_end", "is", null)
    .lt("drink_window_end", currentYear);

  if (wineErr) throw wineErr;
  if (!wines || wines.length === 0) return [];

  // Aggregate inventory counts
  const wineIds = wines.map((w) => w.id);
  const { data: invRows, error: invErr } = await supabase
    .from("inventory_items")
    .select("wine_id, quantity, bin_location")
    .eq("restaurant_id", restaurantId)
    .in("wine_id", wineIds);

  if (invErr) throw invErr;

  const aggByWine = new Map<string, { count: number; bin: string | null }>();
  for (const row of invRows ?? []) {
    if (!row.wine_id) continue;
    const prev = aggByWine.get(row.wine_id) ?? { count: 0, bin: null };
    prev.count += row.quantity ?? 0;
    if (!prev.bin && row.bin_location) prev.bin = row.bin_location;
    aggByWine.set(row.wine_id, prev);
  }

  const rows: PastDrinkWindowRow[] = [];
  for (const w of wines) {
    const inv = aggByWine.get(w.id);
    // Only show wines with stock on hand
    if (!inv || inv.count <= 0) continue;
    rows.push({
      wine_id: w.id,
      name: w.name,
      producer: w.producer,
      vintage: w.vintage,
      drink_window_end: w.drink_window_end,
      bottle_count: inv.count,
      bin_location: inv.bin,
    });
  }

  // Sort: oldest past-peak first (lowest drink_window_end first)
  rows.sort((a, b) => {
    const aEnd = a.drink_window_end ?? 9999;
    const bEnd = b.drink_window_end ?? 9999;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.producer.localeCompare(b.producer);
  });

  return rows;
}
