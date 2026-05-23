import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { enrichWine, type RatingSource } from "@/lib/wine-intelligence/enrich";
import { enrichWineWithClaude } from "@/lib/wine-intelligence/enrich-claude";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

/**
 * BND-039 + BND-261 — single-wine on-demand enrichment.
 *
 * Powers the "Re-enrich" action in the cellar detail drawer. Runs
 * Tier 1 (rule engine) + Tier 2 (Claude fallback) for a single wine.
 *
 * BND-261: includes enrichment_metadata in the RPC payload so the
 * per-wine provenance is tracked alongside the enrichment data.
 *
 * Owner+manager only via requireMembership.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  if (role !== "owner" && role !== "manager") {
    return Errors.forbidden("Enriching wines requires owner or manager role.");
  }

  const { id } = await ctx.params;
  if (!id) {
    return Errors.badRequest("wine id required");
  }

  // Tenant-scoped fetch (defense-in-depth alongside RLS).
  const { data: wine, error: fetchError } = await supabase
    .from("wines")
    .select("id, producer, name, varietal, region, country, vintage")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError || !wine) {
    return Errors.notFound("Wine");
  }

  // Tier 1 — rule engine.
  const ruleResult = enrichWine({
    varietal: wine.varietal,
    region: wine.region,
    country: wine.country,
    vintage: wine.vintage,
  });

  let source: RatingSource | null = ruleResult.ratingSource;
  let payload: Record<string, Json> = {
    id: wine.id,
    drink_window_start: ruleResult.drinkWindowStart,
    drink_window_end: ruleResult.drinkWindowEnd,
    peak_year: ruleResult.peakYear,
    rating_source: ruleResult.ratingSource,
    review_excerpt: ruleResult.reviewExcerpt,
    serving_temp_min: ruleResult.servingTempMin,
    serving_temp_max: ruleResult.servingTempMax,
    serving_temp_label: ruleResult.servingTempLabel,
  };

  let metadataSource = "rule_engine";

  // Tier 2 — Claude fallback when rule engine produced nothing useful.
  if (
    ruleResult.drinkWindowStart == null &&
    ruleResult.servingTempMin == null
  ) {
    const claudeResult = await enrichWineWithClaude({
      producer: wine.producer,
      name: wine.name,
      vintage: wine.vintage,
      varietal: wine.varietal,
      region: wine.region,
      country: wine.country,
    });
    if (claudeResult && claudeResult.drinkWindowStart != null) {
      source = "claude_inference";
      metadataSource = "claude_inference";
      payload = {
        id: wine.id,
        drink_window_start: claudeResult.drinkWindowStart,
        drink_window_end: claudeResult.drinkWindowEnd,
        peak_year: claudeResult.peakYear,
        rating_source: claudeResult.ratingSource,
        review_excerpt: claudeResult.reviewExcerpt,
        serving_temp_min: null,
        serving_temp_max: null,
        serving_temp_label: null,
      };
    }
  }

  if (source == null) {
    return NextResponse.json(
      {
        wineId: wine.id,
        source: null,
        message:
          "Couldn't infer drink window for this wine. Try editing producer/varietal/vintage and retry.",
      },
      { status: 200 },
    );
  }

  // BND-261: attach enrichment_metadata to track provenance.
  const enrichmentFields: string[] = [];
  if (payload.drink_window_start != null || payload.drink_window_end != null) enrichmentFields.push("drink_window");
  if (payload.serving_temp_min != null || payload.serving_temp_max != null || payload.serving_temp_label != null) enrichmentFields.push("serving_temp");
  if (payload.peak_year != null) enrichmentFields.push("peak_year");
  if (payload.rating_source != null) enrichmentFields.push("rating_source");
  if (payload.review_excerpt != null) enrichmentFields.push("review_excerpt");

  (payload as Record<string, unknown>).enrichment_metadata = {
    source: metadataSource,
    fields_enriched: enrichmentFields,
    enriched_at: new Date().toISOString(),
  };

  const { error: rpcError } = await supabase.rpc("enrich_wines_batch", {
    p_restaurant_id: restaurantId,
    p_enrichments: [payload] satisfies Json,
  });

  if (rpcError) {
    Sentry.captureException(rpcError, {
      tags: { surface: "wines-enrich-single", phase: "enrich_wines_batch-rpc" },
      extra: { wineId: wine.id, restaurantId, source },
    });
    return Errors.internal("Failed to write enrichment.");
  }

  return NextResponse.json({
    wineId: wine.id,
    source,
    enrichment: payload,
  });
}
