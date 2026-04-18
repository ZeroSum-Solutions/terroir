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

  let enriched = 0;

  for (const wine of wines ?? []) {
    const result = enrichWine({
      varietal: wine.varietal,
      region: wine.region,
      country: wine.country,
      vintage: wine.vintage,
    });

    // Only update if we got meaningful data
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

      if (!updateError) enriched++;
    }
  }

  return NextResponse.json({
    total: wines?.length ?? 0,
    enriched,
  });
}
