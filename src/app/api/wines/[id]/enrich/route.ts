import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";
import { enrichWine } from "@/lib/wine-intelligence/enrich";
import { enrichWineWithClaude } from "@/lib/wine-intelligence/enrich-claude";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId, role } = auth;
    if (role !== "owner" && role !== "manager") {
      return Errors.forbidden(
        "Enriching wines requires owner or manager role.",
      );
    }

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: wine, error: fetchError } = await supabase
      .from("wines")
      .select(
        "id, producer, name, varietal, region, country, vintage, lwin_id, manual_overrides",
      )
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!wine) return Errors.notFound("Wine");

    const ruleResult = enrichWine({
      varietal: wine.varietal,
      region: wine.region,
      country: wine.country,
      vintage: wine.vintage,
    });
    let source: string | null = ruleResult.ratingSource;
    let metadataSource = "rule_engine";
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

    if (
      ruleResult.drinkWindowStart == null &&
      ruleResult.servingTempMin == null
    ) {
      const inferred = await enrichWineWithClaude({
        producer: wine.producer,
        name: wine.name,
        vintage: wine.vintage,
        varietal: wine.varietal,
        region: wine.region,
        country: wine.country,
      });
      if (inferred?.drinkWindowStart != null) {
        source = "claude_inference";
        metadataSource = "claude_inference";
        payload = {
          id: wine.id,
          drink_window_start: inferred.drinkWindowStart,
          drink_window_end: inferred.drinkWindowEnd,
          peak_year: inferred.peakYear,
          rating_source: inferred.ratingSource,
          review_excerpt: inferred.reviewExcerpt,
          serving_temp_min: null,
          serving_temp_max: null,
          serving_temp_label: null,
          decant_minutes: inferred.decantMinutes ?? null,
        };
      }
    }

    if (source == null) {
      const { data: lwinMatch, error: lwinError } = await supabase.rpc(
        "match_lwin",
        { p_producer: wine.producer, p_name: wine.name },
      );
      if (lwinError) throw lwinError;
      const match = (lwinMatch as Record<string, unknown>[] | null)?.[0];
      if (match?.region || match?.country || match?.varietal || match?.colour) {
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

    if (source == null) {
      return NextResponse.json({
        wineId: wine.id,
        source: null,
        message:
          "Couldn't infer drink window for this wine. Try editing producer/varietal/vintage and retry.",
      });
    }

    const enrichmentFields: string[] = [];
    if (
      payload.drink_window_start != null ||
      payload.drink_window_end != null
    ) {
      enrichmentFields.push("drink_window");
    }
    if (
      payload.serving_temp_min != null ||
      payload.serving_temp_max != null ||
      payload.serving_temp_label != null
    ) {
      enrichmentFields.push("serving_temp");
    }
    if (payload.decant_minutes != null) {
      enrichmentFields.push("decant");
    }
    for (const field of [
      "peak_year",
      "rating_source",
      "review_excerpt",
      "region",
      "country",
      "varietal",
      "colour",
    ]) {
      if (payload[field] != null) enrichmentFields.push(field);
    }
    payload.enrichment_metadata = {
      source: metadataSource,
      fields_enriched: enrichmentFields,
      enriched_at: new Date().toISOString(),
    };

    const { data: updatedCount, error } = await supabase.rpc(
      "enrich_wines_batch",
      {
        p_restaurant_id: restaurantId,
        p_enrichments: [payload] satisfies Json,
      },
    );
    if (error) throw error;
    if (updatedCount !== 1) return Errors.notFound("Wine");

    return NextResponse.json({
      wineId: wine.id,
      source,
      enrichment: payload,
    });
  });
}
