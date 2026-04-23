import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { enrichWine } from "@/lib/wine-intelligence/enrich";

export const runtime = "nodejs";

// ARCH-021: cap per-request workload. A tenant with 10k+ wines
// shouldn't block a request thread fetching the entire catalog. If
// the cap is hit the response says `hasMore=true` and the client can
// re-invoke until all rows are enriched. Tune up if we ever see
// real-world restaurants breaking past this.
const ENRICH_BATCH_LIMIT = 2000;

export async function POST() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // ARCH-021: delta-fetch only wines that actually need enrichment.
  // Previously this route pulled every wine in the tenant (including
  // rows that were already fully enriched on a previous call) and
  // re-evaluated them client-side. With the `.or(...is.null)` filter
  // and a LIMIT, steady-state runs do zero work on already-enriched
  // catalogs.
  const { data: wines, error } = await supabase
    .from("wines")
    .select("id, varietal, region, country, vintage")
    .eq("restaurant_id", restaurantId)
    .or("drink_window_start.is.null,serving_temp_min.is.null")
    .limit(ENRICH_BATCH_LIMIT);

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
    const { data: count, error: rpcError } = await supabase.rpc(
      "enrich_wines_batch",
      { p_restaurant_id: restaurantId, p_enrichments: payload },
    );
    if (rpcError) {
      console.error("enrich_wines_batch failed:", rpcError);
      Sentry.captureException(rpcError, {
        tags: { surface: "wines-enrich", phase: "enrich_wines_batch-rpc" },
        extra: { restaurantId, payloadSize: payload.length },
      });
      return NextResponse.json(
        { error: "Failed to enrich wines." },
        { status: 500 },
      );
    }
    enriched = count ?? 0;
  }

  // ARCH-021: LWIN backfill also bounded. Same reasoning as the
  // enrichment fetch — a massive catalog shouldn't trigger a
  // single mega-call.
  const { data: unmatched } = await supabase
    .from("wines")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .is("lwin_id", null)
    .limit(ENRICH_BATCH_LIMIT);

  let lwinMatched = 0;
  if (unmatched && unmatched.length > 0) {
    const unmatchedIds = unmatched.map((w) => w.id);
    const { data: matches } = await supabase.rpc("match_lwin_batch", {
      p_wine_ids: unmatchedIds,
    });
    lwinMatched = matches?.length ?? 0;
  }

  const processed = wines?.length ?? 0;
  return NextResponse.json({
    total: processed,
    enriched,
    lwinMatched,
    // Client can re-invoke until hasMore=false to finish off a huge catalog.
    hasMore:
      processed >= ENRICH_BATCH_LIMIT ||
      (unmatched?.length ?? 0) >= ENRICH_BATCH_LIMIT,
  });
}
