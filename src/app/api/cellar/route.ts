import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireCapability, requireRole } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import {
  AddCellarWineBodySchema,
  CellarInventoryResultSchema,
} from "@/lib/api/cellar-collection-schemas";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson } from "@/lib/api/validation";
import { enrichWine } from "@/lib/wine-intelligence/enrich";
import type { Database, Json } from "@/types/database";

export const runtime = "nodejs";

type CellarAddOutcome =
  | "added"
  | "replay"
  | "idempotency_key_reused"
  | "idempotency_key_expired"
  | "idempotency_outcome_unknown"
  | "idempotency_in_progress";

type CellarAddResult = {
  outcome: CellarAddOutcome;
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

const CELLAR_ADD_OUTCOMES: readonly CellarAddOutcome[] = [
  "added",
  "replay",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

/** Returns the active restaurant's cellar inventory. */
export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireCapability("cellar:view");
    if (auth instanceof NextResponse) return auth;

    const { data, error } = await auth.supabase
      .from("inventory_items")
      .select(
        "*, wines(id, name, producer, vintage, varietal, region, country, size_ml)",
      )
      .eq("restaurant_id", auth.restaurantId)
      .order("added_at", { ascending: false });
    if (error) throw error;

    return NextResponse.json({ cellar: data ?? [] });
  });
}

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
    const input = {
      name: parsed.data.name,
      producer: parsed.data.producer,
      vintage: parsed.data.vintage ?? null,
      varietal: parsed.data.varietal ?? null,
      region: parsed.data.region ?? null,
      country: parsed.data.country ?? null,
      quantity: parsed.data.quantity,
      unit_cost: parsed.data.unit_cost ?? 0,
    };
    const rawKey = request.headers.get("Idempotency-Key");
    if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
      return Errors.badRequest(
        "Invalid Idempotency-Key.",
        undefined,
        "invalid_idempotency_key",
      );
    }

    const { data, error } = await supabase.rpc(
      "add_cellar_wine_idempotent",
      {
        p_restaurant_id: restaurantId,
        p_name: input.name,
        p_producer: input.producer,
        p_vintage: input.vintage,
        p_varietal: input.varietal,
        p_region: input.region,
        p_country: input.country,
        p_quantity: input.quantity,
        p_unit_cost: input.unit_cost,
        ...(rawKey
          ? {
              p_idempotency_key: rawKey,
              p_request_hash: createIdempotencyRequestHash({ body: input }),
            }
          : {}),
      },
    );
    if (error) {
      if (error.code === "42501") return Errors.forbidden("Forbidden.");
      if (rawKey && error.code === "22023") {
        return Errors.badRequest(
          "Invalid cellar add request.",
          undefined,
          "invalid_cellar_add_request",
        );
      }
      captureBestEffortError(error, "add-wine-rpc", { restaurantId });
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    const result = firstCellarAddResult(data);
    if (!isCellarAddResult(result, rawKey !== null)) {
      captureBestEffortError(
        new Error("add_cellar_wine_idempotent returned an invalid result"),
        "add-wine-result",
        { restaurantId },
      );
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    const response = apiResultResponse({
      status: result.response_status,
      body: result.response_body,
      ...(cellarAddHeaders(result, rawKey !== null)
        ? { headers: cellarAddHeaders(result, rawKey !== null)! }
        : {}),
    });
    if (result.replayed) return response;

    const responseBody = result.response_body as Record<string, unknown>;
    CellarInventoryResultSchema.parse({
      id: responseBody.inventoryId,
      quantity: responseBody.quantity,
      unit_cost: responseBody.unitCost,
    });
    const wineId = z.string().uuid().parse(responseBody.wineId);

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

    return response;
  });
}

function firstCellarAddResult(data: unknown): CellarAddResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0] as CellarAddResult | null;
}

function isCellarAddResult(
  row: CellarAddResult | null,
  isKeyed: boolean,
): row is CellarAddResult {
  if (
    !row ||
    !CELLAR_ADD_OUTCOMES.includes(row.outcome) ||
    !Number.isInteger(row.response_status) ||
    typeof row.replayed !== "boolean" ||
    (row.outcome === "replay") !== row.replayed ||
    !isRecord(row.response_body) ||
    (!isKeyed && row.outcome !== "added")
  ) {
    return false;
  }
  if (row.outcome === "added" || row.outcome === "replay") {
    return (
      row.response_status === 200 &&
      z.string().uuid().safeParse(row.response_body.wineId).success &&
      CellarInventoryResultSchema.safeParse({
        id: row.response_body.inventoryId,
        quantity: row.response_body.quantity,
        unit_cost: row.response_body.unitCost,
      }).success
    );
  }
  const expected: Record<
    Exclude<CellarAddOutcome, "added" | "replay">,
    string
  > = {
    idempotency_key_reused: "idempotency_key_reused",
    idempotency_key_expired: "idempotency_key_expired",
    idempotency_outcome_unknown: "idempotency_outcome_unknown",
    idempotency_in_progress: "idempotency_in_progress",
  };
  return (
    row.response_status === 409 &&
    isRecord(row.response_body.error) &&
    row.response_body.error.code === expected[row.outcome] &&
    typeof row.response_body.error.message === "string"
  );
}

function cellarAddHeaders(
  row: CellarAddResult,
  isKeyed: boolean,
): Record<string, string> | null {
  if (row.outcome === "idempotency_in_progress") {
    return { "Retry-After": "1" };
  }
  if (!isKeyed) return null;
  if (row.outcome === "replay") return { "Idempotency-Replayed": "true" };
  if (row.outcome === "added") return { "Idempotency-Replayed": "false" };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
      { p_restaurant_id: restaurantId, p_wine_ids: [wineId] },
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
