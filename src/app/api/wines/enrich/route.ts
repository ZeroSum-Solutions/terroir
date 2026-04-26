import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { enrichWine } from "@/lib/wine-intelligence/enrich";
import { enrichWineWithClaude } from "@/lib/wine-intelligence/enrich-claude";

export const runtime = "nodejs";

// ARCH-021: cap per-request workload. A tenant with 10k+ wines
// shouldn't block a request thread fetching the entire catalog. If
// the cap is hit the response says `hasMore=true` and the client can
// re-invoke until all rows are enriched. Tune up if we ever see
// real-world restaurants breaking past this.
const ENRICH_BATCH_LIMIT = 2000;

// BND-039: Claude fallback runs after the rule engine. Hard cap per request
// because each call costs real API tokens + adds latency. 50 is the
// realistic upper bound for one tick — bigger backlogs catch up over
// successive client-driven invocations as the bulk-enrich button loops.
const CLAUDE_FALLBACK_MAX_PER_REQUEST = 50;

// BND-039: how many Claude calls run concurrently. The Anthropic SDK
// handles per-call retries; we just cap parallelism so we don't hit
// rate limits on a 50-wine sweep.
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

export async function POST() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  // BND-039 — owner+manager only. requireMembership alone passes staff
  // through; without this gate, staff role can trigger Anthropic
  // billable Claude calls. Mirrors the snooze-alert role check.
  if (role !== "owner" && role !== "manager") {
    return NextResponse.json(
      { error: "Enriching wines requires owner or manager role." },
      { status: 403 },
    );
  }

  // ARCH-021: delta-fetch only wines that actually need enrichment.
  // Previously this route pulled every wine in the tenant (including
  // rows that were already fully enriched on a previous call) and
  // re-evaluated them client-side. With the `.or(...is.null)` filter
  // and a LIMIT, steady-state runs do zero work on already-enriched
  // catalogs.
  //
  // BND-039: also include `producer, name` so Claude fallback has
  // enough signal for an obscure-wine inference.
  const { data: wines, error } = await supabase
    .from("wines")
    .select("id, producer, name, varietal, region, country, vintage")
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

  // BND-031 / DEBT-008 / BND-039 — Tier 1 (rule engine, deterministic, free):
  // compute enrichments in Node and partition wines into "rule_engine matched"
  // vs "rule_engine missed". Misses become candidates for Tier 2 (Claude).
  const ruleEnriched: EnrichmentPayloadRow[] = [];
  const claudeCandidates: typeof wines = [];

  for (const wine of wines ?? []) {
    const result = enrichWine({
      varietal: wine.varietal,
      region: wine.region,
      country: wine.country,
      vintage: wine.vintage,
    });
    // If the rule engine returned anything, take it as the source of truth.
    // Pure miss (no drink window AND no serving temp) → try Claude.
    if (result.servingTempMin == null && result.drinkWindowStart == null) {
      claudeCandidates.push(wine);
      continue;
    }
    ruleEnriched.push({
      id: wine.id,
      drink_window_start: result.drinkWindowStart,
      drink_window_end: result.drinkWindowEnd,
      peak_year: result.peakYear,
      rating_source: result.ratingSource, // 'rule_engine' on rule match
      review_excerpt: result.reviewExcerpt,
      serving_temp_min: result.servingTempMin,
      serving_temp_max: result.servingTempMax,
      serving_temp_label: result.servingTempLabel,
    });
  }

  // BND-039 — Tier 2 (Claude fallback, paid, slower, higher coverage):
  // Cap how many calls we make per request so a 200-wine backlog doesn't
  // burn through Anthropic budget on one click. Subsequent clicks via
  // the bulk-enrich UI catch up incrementally (hasMore=true).
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
        // Claude returns null on rate-limit, parse error, or genuine
        // "too obscure to estimate". Drop those — partial success is
        // better than aborting the batch (architect-review finding 6).
        if (!result || result.drinkWindowStart == null) return null;
        return {
          id: wine.id,
          drink_window_start: result.drinkWindowStart,
          drink_window_end: result.drinkWindowEnd,
          peak_year: result.peakYear,
          rating_source: result.ratingSource,
          review_excerpt: result.reviewExcerpt,
          // Don't overwrite serving_temp from Claude — it's not asked.
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
    ruleEnrichedCount: ruleEnriched.length,
    claudeEnrichedCount: claudeResults.length,
    claudeAttemptedCount: claudeWork.length,
    claudeRemaining,
    lwinMatched,
    // Client can re-invoke until hasMore=false to finish off a huge catalog
    // OR a long Claude backlog.
    hasMore:
      processed >= ENRICH_BATCH_LIMIT ||
      (unmatched?.length ?? 0) >= ENRICH_BATCH_LIMIT ||
      claudeRemaining > 0,
  });
}
