import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { enrichWine } from "@/lib/wine-intelligence/enrich";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

/**
 * BND-039 + BND-261 + BND-277 — single-wine on-demand enrichment.
 *
 * Powers the "Re-enrich" action in the cellar detail drawer. Runs
 * Tier 1 (rule engine) + Tier 2 (LWIN catalog fallback). The former Claude
 * fallback) for a single wine.
 *
 * BND-261: includes enrichment_metadata in the RPC payload so the
 * per-wine provenance is tracked alongside the enrichment data.
 *
 * BND-277 (feature #77): LWIN fallback — when the rule engine returns null,
 * populates region/country/varietal/colour from LWIN catalog with
 * source='lwin_fallback'.
 *
 * BND-278 (feature #78): enrich_wines_batch RPC respects manual_overrides
 * so manually-set fields are never overwritten.
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
  // BND-278: also fetch manual_overrides.
  const { data: wine, error: fetchError } = await supabase
    .from("wines")
    .select("id, producer, name, varietal, region, country, vintage, lwin_id, manual_overrides")
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

  let source: string | null = ruleResult.ratingSource;
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
    decant_minutes: ruleResult.decantMinutes,
  };

  let metadataSource = "rule_engine";

  // Tier 2 (Claude inference) is GONE, deliberately. Its only outputs were
  // drink_window_start/end, peak_year and a review_excerpt the prompt asked
  // for as a "tasting-note style sentence" — values with no source, stored
  // under rating_source = 'claude_inference' and rendered on the wine page
  // looking like sourced fact. It wrote decant_minutes: null and contributed
  // nothing else, so removing those fields removes the tier. A wine the rule
  // engine cannot place now falls straight to the LWIN catalog below, which is
  // free and derived from a real reference rather than invented.
  //
  // See D7 and §3.7 of docs/superpowers/specs/2026-09-03-wine-page-design.md.
  // Removing this is a precondition of the retirement job, not a tidy-up: the
  // batch selector keyed on `drink_window_start is null`, so nulling those
  // values while this tier still ran would have made every retired wine the
  // primary target of the next enrichment run.

  // BND-277 — Tier 3: LWIN catalog fallback when the rule engine produced nothing.
  if (source == null) {
    const { data: lwinMatch } = await supabase.rpc("match_lwin", {
      p_producer: wine.producer,
      p_name: wine.name,
    });

    if (lwinMatch && (lwinMatch as Record<string, unknown>[]).length > 0) {
      const match = (lwinMatch as Record<string, unknown>[])[0];
      const hasMetadata =
        match.region || match.country || match.varietal || match.colour;

      if (hasMetadata) {
        source = "lwin_fallback";
        metadataSource = "lwin_fallback";
        payload = {
          id: wine.id,
          drink_window_start: null,
          drink_window_end: null,
          peak_year: null,
          rating_source: null,
          review_excerpt: null,
          serving_temp_min: null,
          serving_temp_max: null,
          serving_temp_label: null,
          decant_minutes: null,
          region: (match.region as string) ?? null,
          country: (match.country as string) ?? null,
          varietal: (match.varietal as string) ?? null,
          colour: (match.colour as string) ?? null,
        };
      }
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
  if (payload.decant_minutes != null) enrichmentFields.push("decant");
  if (payload.peak_year != null) enrichmentFields.push("peak_year");
  if (payload.rating_source != null) enrichmentFields.push("rating_source");
  if (payload.review_excerpt != null) enrichmentFields.push("review_excerpt");
  if (payload.region != null) enrichmentFields.push("region");
  if (payload.country != null) enrichmentFields.push("country");
  if (payload.varietal != null) enrichmentFields.push("varietal");
  if (payload.colour != null) enrichmentFields.push("colour");

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
