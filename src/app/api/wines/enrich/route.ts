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

  // BND-031 / DEBT-008: compute enrichments in Node via the deterministic
  // rule engine, then ship the whole batch to enrich_wines_batch in one
  // round-trip. Rows where the rule engine returns all-nulls are filtered
  // out — no point paying for an empty UPDATE.
  const payload = (wines ?? [])
    .map((wine) => {
      const result = enrichWine({
        varietal: wine.varietal,
        region: wine.region,
        country: wine.country,
        vintage: wine.vintage,
      });
      if (result.servingTempMin == null && result.drinkWindowStart == null) {
        return null;
      }
      return {
        id: wine.id,
        drink_window_start: result.drinkWindowStart,
        drink_window_end: result.drinkWindowEnd,
        serving_temp_min: result.servingTempMin,
        serving_temp_max: result.servingTempMax,
        serving_temp_label: result.servingTempLabel,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  let enriched = 0;
  if (payload.length > 0) {
    const { data: count, error: rpcError } = await (supabase.rpc as unknown as (
      fn: string,
      args: { p_restaurant_id: string; p_enrichments: typeof payload },
    ) => Promise<{ data: number | null; error: unknown }>)(
      "enrich_wines_batch",
      { p_restaurant_id: restaurantId, p_enrichments: payload },
    );
    if (rpcError) {
      console.error("enrich_wines_batch failed:", rpcError);
      return NextResponse.json(
        { error: "Failed to enrich wines." },
        { status: 500 },
      );
    }
    enriched = count ?? 0;
  }

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
