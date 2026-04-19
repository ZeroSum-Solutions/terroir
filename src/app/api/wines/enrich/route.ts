import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { enrichWine } from "@/lib/wine-intelligence/enrich";

export const runtime = "nodejs";

export async function POST() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // Fetch all wines for this restaurant
  const { data: wines, error } = await supabase
    .from("wines")
    .select("id, varietal, region, country, vintage")
    .eq("restaurant_id", restaurantId);

  if (error) {
    console.error("wines fetch failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch wines." },
      { status: 500 },
    );
  }

  const updates = (wines ?? []).map(async (wine) => {
    const result = enrichWine({
      varietal: wine.varietal,
      region: wine.region,
      country: wine.country,
      vintage: wine.vintage,
    });

    if (result.servingTempMin != null || result.drinkWindowStart != null) {
      const { error: updateError } = await supabase
        .from("wines")
        .update({
          drink_window_start: result.drinkWindowStart,
          drink_window_end: result.drinkWindowEnd,
          serving_temp_min: result.servingTempMin,
          serving_temp_max: result.servingTempMax,
          serving_temp_label: result.servingTempLabel,
        })
        .eq("id", wine.id);

      return updateError ? 0 : 1 as number;
    }
    return 0 as number;
  });

  const results = await Promise.all(updates);
  const enriched = results.reduce((s, v) => s + v, 0);

  // LWIN backfill for wines without lwin_id
  const { data: unmatched } = await supabase
    .from("wines")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .is("lwin_id", null);

  let lwinMatched = 0;
  if (unmatched && unmatched.length > 0) {
    const unmatchedIds = unmatched.map((w) => w.id);
    const { data: matches } = await supabase.rpc("match_lwin_batch", {
      p_wine_ids: unmatchedIds,
    });
    lwinMatched = matches?.length ?? 0;
  }

  return NextResponse.json({
    total: wines?.length ?? 0,
    enriched,
    lwinMatched,
  });
}
