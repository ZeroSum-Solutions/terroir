/**
 * BND-015 — enrich-batch orchestration helper.
 *
 * Extracted from POST /api/wines/enrich so the orchestration is
 * independently testable. The route becomes a thin auth+delegate shell.
 *
 * Orchestration tiers:
 *   Tier 1 — rule engine (deterministic, free): enrichWine()
 *   Tier 2 — Claude fallback (paid, higher coverage): enrichWinesWithClaudeBatch()
 *   Tier 3 — LWIN catalog fallback (free, best-effort metadata): lwinEnrichFallback()
 *
 * BND-039: Claude fallback is hard-capped per request to avoid burning
 * Anthropic budget on a single click. Clients re-invoke until hasMore=false.
 *
 * BND-262 (feature #75): Claude calls are batched — all candidate wines
 * go in a single Claude API call (one system prompt, one round trip),
 * instead of one call per wine.
 *
 * BND-277 (feature #77): LWIN fallback — when Claude returns null, the
 * system populates region/country/varietal/colour from the LWIN catalog
 * and marks enrichment_metadata.source = 'lwin_fallback'.
 *
 * BND-278 (feature #78): Manual overrides — enrichment never overwrites
 * fields the user has manually set. The enrich_wines_batch RPC checks
 * manual_overrides before writing each field.
 *
 * ARCH-021: fetch and LWIN backfill are bounded by ENRICH_BATCH_LIMIT so
 * large catalogs don't block a request thread.
 */

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { enrichWine } from "./enrich";
import { enrichWinesWithClaudeBatch } from "./enrich-claude";

// ARCH-021: cap per-request workload.
const ENRICH_BATCH_LIMIT = 2000;

// BND-039: Claude fallback hard cap per request.
const CLAUDE_FALLBACK_MAX_PER_REQUEST = 50;

type EnrichmentMetadata = {
  source: string;
  fields_enriched: string[];
  enriched_at: string;
};

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
  decant_minutes: number | null;
  region?: string | null;
  country?: string | null;
  varietal?: string | null;
  colour?: string | null;
  enrichment_metadata: EnrichmentMetadata;
};

function buildMetadata(source: string, result: {
  drinkWindowStart: number | null;
  drinkWindowEnd: number | null;
  peakYear: number | null;
  ratingSource: string | null;
  reviewExcerpt: string | null;
  servingTempMin: number | null;
  servingTempMax: number | null;
  servingTempLabel: string | null;
  decantMinutes?: number | null;
  region?: string | null;
  country?: string | null;
  varietal?: string | null;
  colour?: string | null;
}): EnrichmentMetadata {
  const fields: string[] = [];
  if (result.drinkWindowStart != null || result.drinkWindowEnd != null) fields.push("drink_window");
  if (result.servingTempMin != null || result.servingTempMax != null || result.servingTempLabel != null) fields.push("serving_temp");
  if (result.decantMinutes != null) fields.push("decant");
  if (result.peakYear != null) fields.push("peak_year");
  if (result.ratingSource != null) fields.push("rating_source");
  if (result.reviewExcerpt != null) fields.push("review_excerpt");
  if (result.region != null) fields.push("region");
  if (result.country != null) fields.push("country");
  if (result.varietal != null) fields.push("varietal");
  if (result.colour != null) fields.push("colour");
  return {
    source,
    fields_enriched: fields,
    enriched_at: new Date().toISOString(),
  };
}

/**
 * BND-277 — Tier 3 LWIN catalog fallback.
 *
 * For wines where neither the rule engine nor Claude produced enrichment,
 * match against the LWIN catalog and populate region/country/varietal/colour
 * metadata with source='lwin_fallback'.
 */
async function lwinEnrichFallback(
  supabase: SupabaseClient<Database>,
  wines: Array<{ id: string; producer: string; name: string }>,
): Promise<EnrichmentPayloadRow[]> {
  if (wines.length === 0) return [];

  const wineIds = wines.map((w) => w.id);

  // Run match_lwin_batch to assign LWIN IDs to unmatched wines.
  const { data: matches } = await supabase.rpc("match_lwin_batch", {
    p_wine_ids: wineIds,
  });

  if (!matches || matches.length === 0) return [];

  // Fetch the wines that got matched to get their lwin_id values.
  const matchedIds = new Set(
    (matches as Array<{ wine_id: string }>).map((m) => m.wine_id),
  );

  const { data: winesWithLwin } = await supabase
    .from("wines")
    .select("id, lwin_id")
    .in("id", Array.from(matchedIds))
    .not("lwin_id", "is", null);

  if (!winesWithLwin || winesWithLwin.length === 0) return [];

  const lwinIds = [...new Set(winesWithLwin.map((w) => w.lwin_id as string))];

  // Fetch LWIN catalog entries for the matched LWIN IDs.
  const { data: catalogEntries } = await supabase
    .from("lwin_catalog")
    .select("lwin_id, region, country, varietal, colour")
    .in("lwin_id", lwinIds);

  if (!catalogEntries || catalogEntries.length === 0) return [];

  const catalogByLwinId = new Map(
    catalogEntries.map((e) => [e.lwin_id, e]),
  );

  const results: EnrichmentPayloadRow[] = [];

  for (const wine of winesWithLwin) {
    if (!wine.lwin_id) continue;
    const catalog = catalogByLwinId.get(wine.lwin_id);
    if (!catalog) continue;

    // Only create a payload if at least one metadata field is present.
    if (!catalog.region && !catalog.country && !catalog.varietal && !catalog.colour) continue;

    results.push({
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
      region: catalog.region,
      country: catalog.country,
      varietal: catalog.varietal,
      colour: catalog.colour,
      enrichment_metadata: buildMetadata("lwin_fallback", {
        drinkWindowStart: null,
        drinkWindowEnd: null,
        peakYear: null,
        ratingSource: null,
        reviewExcerpt: null,
        servingTempMin: null,
        servingTempMax: null,
        servingTempLabel: null,
        region: catalog.region,
        country: catalog.country,
        varietal: catalog.varietal,
        colour: catalog.colour,
      }),
    });
  }

  return results;
}

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
      lwinFallbackCount: number;
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
  // BND-278: also fetch manual_overrides for field-preservation checks.
  const { data: wines, error } = await supabase
    .from("wines")
    .select("id, producer, name, varietal, region, country, vintage, manual_overrides")
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
      decant_minutes: result.decantMinutes,
      enrichment_metadata: buildMetadata("rule_engine", result),
    });
  }

  // BND-262 — Tier 2 (Claude fallback, single batched call, paid).
  const claudeWork = claudeCandidates.slice(0, CLAUDE_FALLBACK_MAX_PER_REQUEST);
  const claudeRemaining = Math.max(
    0,
    claudeCandidates.length - CLAUDE_FALLBACK_MAX_PER_REQUEST,
  );

  const claudeResults: EnrichmentPayloadRow[] = [];
  const claudeNullResults: Array<{ id: string; producer: string; name: string }> = [];

  if (claudeWork.length > 0) {
    const batchResults = await enrichWinesWithClaudeBatch(claudeWork);
    for (let i = 0; i < claudeWork.length; i++) {
      const result = batchResults[i];
      if (!result || result.drinkWindowStart == null) {
        // BND-277 — collect for LWIN fallback
        claudeNullResults.push({
          id: claudeWork[i].id,
          producer: claudeWork[i].producer,
          name: claudeWork[i].name,
        });
        continue;
      }
      claudeResults.push({
        id: claudeWork[i].id,
        drink_window_start: result.drinkWindowStart,
        drink_window_end: result.drinkWindowEnd,
        peak_year: result.peakYear,
        rating_source: result.ratingSource,
        review_excerpt: result.reviewExcerpt,
        serving_temp_min: null,
        serving_temp_max: null,
        serving_temp_label: null,
        decant_minutes: null,
        enrichment_metadata: buildMetadata("claude_inference", result),
      });
    }
  }

  // BND-277 — Tier 3 (LWIN catalog fallback, free, best-effort).
  const lwinFallbackResults = await lwinEnrichFallback(supabase, claudeNullResults);

  const payload = [...ruleEnriched, ...claudeResults, ...lwinFallbackResults];

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
    lwinFallbackCount: lwinFallbackResults.length,
    lwinMatched,
    hasMore:
      processed >= ENRICH_BATCH_LIMIT ||
      (unmatched?.length ?? 0) >= ENRICH_BATCH_LIMIT ||
      claudeRemaining > 0,
  };
}
