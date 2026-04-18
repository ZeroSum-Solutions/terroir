import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enrichWine } from "@/lib/wine-intelligence/enrich";

export const runtime = "nodejs";

export async function POST() {
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

  // Fetch all wines for this restaurant
  const { data: wines, error } = await supabase
    .from("wines")
    .select("id, varietal, region, country, vintage")
    .eq("restaurant_id", rid);

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
