import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import {
  AddCellarWineBodySchema,
  CellarInventoryResultSchema,
} from "@/lib/api/cellar-collection-schemas";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { enrichWine } from "@/lib/wine-intelligence/enrich";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

function buildEnrichmentMetadata(result: ReturnType<typeof enrichWine>) {
  const fields: string[] = [];
  if (result.drinkWindowStart != null || result.drinkWindowEnd != null) {
    fields.push("drink_window");
  }
  if (
    result.servingTempMin != null ||
    result.servingTempMax != null ||
    result.servingTempLabel != null
  ) {
    fields.push("serving_temp");
  }
  if (result.decantMinutes != null) fields.push("decant");
  if (result.peakYear != null) fields.push("peak_year");
  if (result.ratingSource != null) fields.push("rating_source");
  if (result.reviewExcerpt != null) fields.push("review_excerpt");
  return {
    source: "rule_engine",
    fields_enriched: fields,
    enriched_at: new Date().toISOString(),
  };
}

/**
 * POST /api/cellar — add a wine to the cellar inventory.
 *
 * Role-gated to owner/manager.
 * Creates the wine via find_or_create_wines_batch, inserts an
 * inventory_items row with added_via = "manual", and triggers
 * rule-engine enrichment for the new wine.
 */
export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, AddCellarWineBodySchema);
    if (!parsed.ok) return parsed.response;
    const {
      name,
      producer,
      vintage,
      varietal,
      region,
      country,
      quantity,
      unit_cost,
    } = parsed.data;

    const { data: wineIds, error: batchError } = await supabase.rpc(
      "find_or_create_wines_batch",
      {
        p_restaurant_id: restaurantId,
        p_wines: [
          {
            name,
            producer,
            vintage: vintage ?? null,
            varietal: varietal ?? null,
            region: region ?? null,
            country: country ?? null,
            size_ml: 750,
          },
        ],
      },
    );
    if (batchError) throw batchError;
    const parsedWineId = z.string().uuid().safeParse(wineIds?.[0]);
    if (!parsedWineId.success) {
      throw new Error("find-or-create wine RPC returned no valid ID");
    }
    const wineId = parsedWineId.data;

    const { data: rawInventoryItem, error: inventoryError } = await supabase
      .from("inventory_items")
      .insert({
        wine_id: wineId,
        restaurant_id: restaurantId,
        quantity,
        unit_cost: unit_cost ?? 0,
        added_via: "manual" as const,
      })
      .select("id, quantity, unit_cost")
      .maybeSingle();
    if (inventoryError) throw inventoryError;
    const inventoryItem =
      CellarInventoryResultSchema.safeParse(rawInventoryItem);
    if (!inventoryItem.success) {
      throw new Error("Inventory insert returned an invalid result");
    }

    await runBestEffortLwinMatch({
      supabase,
      restaurantId,
      wineId,
    });

    const canonicalWine = await loadCanonicalWineForEnrichment({
      supabase,
      restaurantId,
      wineId,
    });
    if (canonicalWine) {
      await runBestEffortEnrichment({
        supabase,
        restaurantId,
        wineId,
        ...canonicalWine,
      });
    }

    return NextResponse.json({
      wineId,
      inventoryId: inventoryItem.data.id,
      quantity: inventoryItem.data.quantity,
      unitCost: inventoryItem.data.unit_cost,
    });
  });
}

async function runBestEffortLwinMatch(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
}): Promise<void> {
  const { supabase, restaurantId, wineId } = input;
  try {
    const { data: lwinMatches, error: lwinError } = await supabase.rpc(
      "match_lwin_batch",
      { p_wine_ids: [wineId] },
    );
    if (lwinError) {
      captureBestEffortError(lwinError, "match-lwin", {
        restaurantId,
        wineId,
      });
    } else if (!Array.isArray(lwinMatches)) {
      captureBestEffortError(
        new Error("match_lwin_batch returned an invalid result"),
        "match-lwin-result",
        { restaurantId, wineId },
      );
    }
  } catch (error) {
    captureBestEffortError(error, "match-lwin", {
      restaurantId,
      wineId,
    });
  }
}

async function loadCanonicalWineForEnrichment(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
}): Promise<{
  varietal: string | null;
  region: string | null;
  country: string | null;
  vintage: number | null;
} | null> {
  const { supabase, restaurantId, wineId } = input;
  try {
    const { data, error } = await supabase
      .from("wines")
      .select("varietal, region, country, vintage")
      .eq("restaurant_id", restaurantId)
      .eq("id", wineId)
      .maybeSingle();
    if (error) {
      captureBestEffortError(error, "load-canonical-wine", {
        restaurantId,
        wineId,
      });
      return null;
    }
    if (!data) {
      captureBestEffortError(
        new Error("Canonical wine was not found after inventory insert"),
        "load-canonical-wine-result",
        { restaurantId, wineId },
      );
      return null;
    }
    return data;
  } catch (error) {
    captureBestEffortError(error, "load-canonical-wine", {
      restaurantId,
      wineId,
    });
    return null;
  }
}

async function runBestEffortEnrichment(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
  varietal: string | null;
  region: string | null;
  country: string | null;
  vintage: number | null;
}): Promise<void> {
  const {
    supabase,
    restaurantId,
    wineId,
    varietal,
    region,
    country,
    vintage,
  } = input;
  try {
    const result = enrichWine({ varietal, region, country, vintage });
    if (result.drinkWindowStart == null && result.servingTempMin == null) {
      return;
    }
    const { data: updatedCount, error } = await supabase.rpc(
      "enrich_wines_batch",
      {
        p_restaurant_id: restaurantId,
        p_enrichments: [
          {
            id: wineId,
            drink_window_start: result.drinkWindowStart,
            drink_window_end: result.drinkWindowEnd,
            peak_year: result.peakYear,
            rating: null,
            rating_source: result.ratingSource ?? null,
            review_excerpt: result.reviewExcerpt ?? null,
            serving_temp_min: result.servingTempMin,
            serving_temp_max: result.servingTempMax,
            serving_temp_label: result.servingTempLabel ?? null,
            decant_minutes: result.decantMinutes ?? null,
            enrichment_metadata: buildEnrichmentMetadata(result),
          },
        ],
      },
    );
    if (error) {
      captureBestEffortError(error, "enrich-wine", {
        restaurantId,
        wineId,
      });
    } else if (updatedCount !== 1) {
      captureBestEffortError(
        new Error("enrich_wines_batch updated an unexpected row count"),
        "enrich-wine-result",
        { restaurantId, wineId, updatedCount },
      );
    }
  } catch (error) {
    captureBestEffortError(error, "enrich-wine", {
      restaurantId,
      wineId,
    });
  }
}

function captureBestEffortError(
  error: unknown,
  phase: string,
  extra: Record<string, unknown>,
): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "cellar", phase },
      extra,
    });
  } catch {
    // Observability must never convert a completed inventory write into a 500.
  }
}
