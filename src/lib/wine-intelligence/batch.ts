/**
 * BND-015 — enrich-batch orchestration helper.
 *
 * Extracted from POST /api/wines/enrich so the orchestration is
 * independently testable. The route becomes a thin auth+delegate shell.
 *
 * Orchestration tiers (unchanged from route):
 *   Tier 1 — rule engine (deterministic, free): enrichWine()
 *   Tier 2 — Claude fallback (paid, higher coverage): enrichWineWithClaude()
 *
 * BND-039: Claude fallback is hard-capped per request to avoid burning
 * Anthropic budget on a single click. Clients re-invoke until hasMore=false.
 *
 * ARCH-021: fetch and LWIN backfill are bounded by ENRICH_BATCH_LIMIT so
 * large catalogs don't block a request thread.
 */

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { enrichWine } from "./enrich";
import { enrichWineWithClaude } from "./enrich-claude";

// ARCH-021: cap per-request workload.
const ENRICH_BATCH_LIMIT = 2000;

// BND-039: Claude fallback hard cap per request.
const CLAUDE_FALLBACK_MAX_PER_REQUEST = 50;

// BND-039: Claude concurrency cap to avoid rate-limit spikes.
const CLAUDE_CONCURRENCY = 5;

type EnrichmentPayloadRow = {
  id: string;
  drink_window_start: number | null;
  drink_window_end: number | null;
  peak_year: number | null;
  rating_source: string | null;
  review_excerpt: string | null;
  serving_temp_min: number | null;
  serving_temp_max: number | null;
  serving_temp_label: string | null;
};

export type EnrichRestaurantBatchInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
};

/**
 * Result is either a success (all summary fields present) or an error
 * (just `error` + `status`). Modeled as a discriminated union via the
 * `error` discriminator so callers narrow naturally:
 *   if (result.error) return errorResponse(result);
 *   // result.total etc. are now `number`, not `number | undefined`
 */
export type EnrichRestaurantBatchResult =
  | {
      error?: undefined;
      status?: undefined;
      total: number;
      enriched: number;
      ruleEnrichedCount: number;
      claudeEnrichedCount: number;
      claudeAttemptedCount: number;
      claudeRemaining: number;
      lwinMatched: number;
      hasMore: boolean;
    }
  | { error: string; status: number };

export async function enrichRestaurantBatch(
  input: EnrichRestaurantBatchInput,
): Promise<EnrichRestaurantBatchResult> {
  const { supabase, restaurantId } = input;

  // ARCH-021: delta-fetch only wines that actually need enrichment.
  // BND-039: also include `producer, name` so Claude fallback has enough signal.
  const { data: wines, error } = await supabase
    .from("wines")
    .select("id, producer, name, varietal, region, country, vintage")
    .eq("restaurant_id", restaurantId)
    .or("drink_window_start.is.null,serving_temp_min.is.null")
    .limit(ENRICH_BATCH_LIMIT);

  if (error) {
    console.error("wines fetch failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wines-enrich", phase: "fetch" },
      extra: { restaurantId },
    });
    return { error: "Failed to fetch wines.", status: 500 };
  }

  // BND-031 / DEBT-008 / BND-039 — Tier 1 (rule engine, deterministic, free).
  const ruleEnriched: EnrichmentPayloadRow[] = [];
  const claudeCandidates: typeof wines = [];

  for (const wine of wines ?? []) {
    const result = enrichWine({
      varietal: wine.varietal,
      region: wine.region,
      country: wine.country,
      vintage: wine.vintage,
    });
    if (result.servingTempMin == null && result.drinkWindowStart == null) {
      claudeCandidates.push(wine);
      continue;
    }
    ruleEnriched.push({
      id: wine.id,
      drink_window_start: result.drinkWindowStart,
      drink_window_end: result.drinkWindowEnd,
      peak_year: result.peakYear,
      rating_source: result.ratingSource,
      review_excerpt: result.reviewExcerpt,
      serving_temp_min: result.servingTempMin,
      serving_temp_max: result.servingTempMax,
      serving_temp_label: result.servingTempLabel,
    });
  }

  // BND-039 — Tier 2 (Claude fallback, paid, slower, higher coverage).
  const claudeWork = claudeCandidates.slice(0, CLAUDE_FALLBACK_MAX_PER_REQUEST);
  const claudeRemaining = Math.max(
    0,
    claudeCandidates.length - CLAUDE_FALLBACK_MAX_PER_REQUEST,
  );

  const claudeResults: EnrichmentPayloadRow[] = [];
  for (let i = 0; i < claudeWork.length; i += CLAUDE_CONCURRENCY) {
    const slice = claudeWork.slice(i, i + CLAUDE_CONCURRENCY);
    const settled = await Promise.all(
      slice.map(async (wine) => {
        const result = await enrichWineWithClaude({
          producer: wine.producer,
          name: wine.name,
          vintage: wine.vintage,
          varietal: wine.varietal,
          region: wine.region,
          country: wine.country,
        });
        if (!result || result.drinkWindowStart == null) return null;
        return {
          id: wine.id,
          drink_window_start: result.drinkWindowStart,
          drink_window_end: result.drinkWindowEnd,
          peak_year: result.peakYear,
          rating_source: result.ratingSource,
          review_excerpt: result.reviewExcerpt,
          serving_temp_min: null,
          serving_temp_max: null,
          serving_temp_label: null,
        } satisfies EnrichmentPayloadRow;
      }),
    );
    for (const row of settled) {
      if (row) claudeResults.push(row);
    }
  }

  const payload = [...ruleEnriched, ...claudeResults];

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
      return { error: "Failed to enrich wines.", status: 500 };
    }
    enriched = count ?? 0;
  }

  // ARCH-021: LWIN backfill, also bounded.
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
  return {
    total: processed,
    enriched,
    ruleEnrichedCount: ruleEnriched.length,
    claudeEnrichedCount: claudeResults.length,
    claudeAttemptedCount: claudeWork.length,
    claudeRemaining,
    lwinMatched,
    hasMore:
      processed >= ENRICH_BATCH_LIMIT ||
      (unmatched?.length ?? 0) >= ENRICH_BATCH_LIMIT ||
      claudeRemaining > 0,
  };
}
