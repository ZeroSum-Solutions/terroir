import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { enrichWine, type RatingSource } from "@/lib/wine-intelligence/enrich";
import { enrichWineWithClaude } from "@/lib/wine-intelligence/enrich-claude";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

/**
 * BND-039 — single-wine on-demand enrichment.
 *
 * Powers the "Refresh drink window for this wine" action in the cellar
 * detail drawer. The bulk-enrich endpoint (`/api/wines/enrich`) runs the
 * same Tier 1 (rule engine) + Tier 2 (Claude fallback) pipeline but
 * iterates over many wines — this route does it for one.
 *
 * Always runs Claude when the rule engine misses, regardless of whether
 * Claude has been tried before. Owners use this when they want to retry
 * a previously-failed enrichment.
 *
 * Owner+manager only via `requireMembership` (route-level), matching the
 * bulk endpoint.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  // BND-039 — owner+manager only. Staff role can authenticate but
  // cannot trigger billable Claude inference. Mirrors snooze-alert
  // and the bulk enrich endpoint.
  if (role !== "owner" && role !== "manager") {
    return NextResponse.json(
      { error: "Enriching wines requires owner or manager role." },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "wine id required" }, { status: 400 });
  }

  // Tenant-scoped fetch (defense-in-depth alongside RLS).
  const { data: wine, error: fetchError } = await supabase
    .from("wines")
    .select("id, producer, name, varietal, region, country, vintage")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError || !wine) {
    return NextResponse.json({ error: "Wine not found." }, { status: 404 });
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
      payload = {
        id: wine.id,
        drink_window_start: claudeResult.drinkWindowStart,
        drink_window_end: claudeResult.drinkWindowEnd,
        peak_year: claudeResult.peakYear,
        rating_source: claudeResult.ratingSource,
        review_excerpt: claudeResult.reviewExcerpt,
        // Don't overwrite serving_temp from Claude — it's not asked.
        serving_temp_min: null,
        serving_temp_max: null,
        serving_temp_label: null,
      };
    }
  }

  if (source == null) {
    // Genuinely couldn't enrich — caller should know vs silent success.
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

  const { error: rpcError } = await supabase.rpc("enrich_wines_batch", {
    p_restaurant_id: restaurantId,
    p_enrichments: [payload] satisfies Json,
  });

  if (rpcError) {
    Sentry.captureException(rpcError, {
      tags: { surface: "wines-enrich-single", phase: "enrich_wines_batch-rpc" },
      extra: { wineId: wine.id, restaurantId, source },
    });
    return NextResponse.json(
      { error: "Failed to write enrichment." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    wineId: wine.id,
    source,
    enrichment: payload,
  });
}
