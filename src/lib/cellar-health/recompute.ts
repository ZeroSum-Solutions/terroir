import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  HEALTH_SEGMENTS,
  classifyCellarHealth,
  deriveAppreciation,
  type CellarHealthSegment,
  type CellarHealthThresholds,
} from "./classify";

type Client = SupabaseClient<Database>;

export type CellarHealthRecomputeResult = {
  classified: number;
  segments: Record<CellarHealthSegment, number>;
};

export async function runCellarHealthRecompute(
  admin: Client,
  restaurantId: string,
  userId: string,
  now: Date = new Date(),
): Promise<CellarHealthRecomputeResult> {
  const jobId = await startJob(admin, restaurantId, userId, now);
  try {
    const inputs = await loadInputs(admin, restaurantId);
    const rows = buildHealthRows(inputs, restaurantId, now);
    if (rows.length > 0) {
      const { error } = await admin
        .from("cellar_health")
        .upsert(rows, { onConflict: "restaurant_id,wine_id" });
      if (error) throw error;
    }
    await removeStaleHealthRows(
      admin,
      restaurantId,
      inputs.existingHealthWineIds,
      rows,
    );
    const segments = countSegments(rows);
    await finishJob(admin, jobId, now, rows.length, segments);
    return { classified: rows.length, segments };
  } catch (error) {
    await failJob(admin, jobId, now, error);
    throw error;
  }
}

async function startJob(
  admin: Client,
  restaurantId: string,
  userId: string,
  now: Date,
) {
  const { data, error } = await admin
    .from("background_jobs")
    .insert({
      restaurant_id: restaurantId,
      created_by: userId,
      job_type: "cellar_health",
      status: "processing",
      started_at: now.toISOString(),
      attempt_count: 1,
      metadata: {},
      result: {},
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function loadInputs(admin: Client, restaurantId: string) {
  const [wines, inventory, pours, config, existingHealth] = await Promise.all([
    admin
      .from("wines")
      .select("id, drink_window_start, drink_window_end, retail_median")
      .eq("restaurant_id", restaurantId),
    admin
      .from("inventory_items")
      .select("wine_id, quantity, unit_cost, added_at")
      .eq("restaurant_id", restaurantId),
    admin
      .from("pour_events")
      .select("wine_id, occurred_at")
      .eq("restaurant_id", restaurantId),
    admin
      .from("cellar_config")
      .select(
        "health_dead_stock_days, health_cash_trap_floor, health_appreciation_threshold",
      )
      .eq("restaurant_id", restaurantId)
      .limit(1)
      .maybeSingle(),
    admin
      .from("cellar_health")
      .select("wine_id")
      .eq("restaurant_id", restaurantId),
  ]);
  for (const result of [wines, inventory, pours, config, existingHealth]) {
    if (result.error) throw result.error;
  }
  return {
    wines: wines.data ?? [],
    inventory: inventory.data ?? [],
    pours: pours.data ?? [],
    thresholds: thresholdsFromConfig(config.data),
    existingHealthWineIds: (existingHealth.data ?? []).map((row) => row.wine_id),
  };
}

type LoadedInputs = Awaited<ReturnType<typeof loadInputs>>;
type HealthInsert = Database["public"]["Tables"]["cellar_health"]["Insert"];

function buildHealthRows(
  inputs: LoadedInputs,
  restaurantId: string,
  now: Date,
): HealthInsert[] {
  const stockByWine = aggregateStock(inputs.inventory);
  const lastPourByWine = latestPourDates(inputs.pours);
  const computedAt = now.toISOString();
  return inputs.wines.flatMap((wine) => {
    const stock = stockByWine.get(wine.id);
    if (!stock || stock.quantity <= 0) return [];
    const result = classifyCellarHealth(
      {
        drinkWindowStart: wine.drink_window_start,
        drinkWindowEnd: wine.drink_window_end,
        stockValue: stock.value,
        lastMovementAt: lastPourByWine.get(wine.id) ?? stock.latestAddedAt,
        appreciation: deriveAppreciation(
          wine.retail_median,
          stock.value / stock.quantity,
        ),
      },
      inputs.thresholds,
      now,
    );
    return [{
      restaurant_id: restaurantId,
      wine_id: wine.id,
      segment: result.segment,
      reason: result.reason,
      computed_at: computedAt,
    }];
  });
}

function aggregateStock(inputs: LoadedInputs["inventory"]) {
  const stock = new Map<
    string,
    { quantity: number; value: number; latestAddedAt: string | null }
  >();
  for (const item of inputs) {
    const current = stock.get(item.wine_id) ?? {
      quantity: 0,
      value: 0,
      latestAddedAt: null,
    };
    current.quantity += item.quantity;
    current.value += item.quantity * item.unit_cost;
    if (!current.latestAddedAt || item.added_at > current.latestAddedAt) {
      current.latestAddedAt = item.added_at;
    }
    stock.set(item.wine_id, current);
  }
  return stock;
}

function latestPourDates(inputs: LoadedInputs["pours"]) {
  const latest = new Map<string, string>();
  for (const pour of inputs) {
    const current = latest.get(pour.wine_id);
    if (!current || pour.occurred_at > current) latest.set(pour.wine_id, pour.occurred_at);
  }
  return latest;
}

function thresholdsFromConfig(
  config: {
    health_dead_stock_days: number;
    health_cash_trap_floor: number;
    health_appreciation_threshold: number;
  } | null,
): CellarHealthThresholds {
  if (!config) return DEFAULT_HEALTH_THRESHOLDS;
  return {
    deadStockDays: config.health_dead_stock_days,
    cashTrapFloor: config.health_cash_trap_floor,
    appreciationThreshold: config.health_appreciation_threshold,
  };
}

function countSegments(rows: HealthInsert[]) {
  const counts = Object.fromEntries(
    HEALTH_SEGMENTS.map((segment) => [segment, 0]),
  ) as Record<CellarHealthSegment, number>;
  for (const row of rows) {
    const segment = row.segment as CellarHealthSegment;
    counts[segment] += 1;
  }
  return counts;
}

async function removeStaleHealthRows(
  admin: Client,
  restaurantId: string,
  existingWineIds: string[],
  currentRows: HealthInsert[],
) {
  const currentWineIds = new Set(currentRows.map((row) => row.wine_id));
  const staleWineIds = existingWineIds.filter((wineId) => !currentWineIds.has(wineId));
  if (staleWineIds.length === 0) return;
  const { error } = await admin
    .from("cellar_health")
    .delete()
    .eq("restaurant_id", restaurantId)
    .in("wine_id", staleWineIds);
  if (error) throw error;
}

async function finishJob(
  admin: Client,
  jobId: string,
  now: Date,
  classified: number,
  segments: Record<CellarHealthSegment, number>,
) {
  const { error } = await admin
    .from("background_jobs")
    .update({
      status: "succeeded",
      finished_at: now.toISOString(),
      result: { classified, segments },
    })
    .eq("id", jobId);
  if (error) throw error;
}

async function failJob(admin: Client, jobId: string, now: Date, cause: unknown) {
  const { error } = await admin
    .from("background_jobs")
    .update({
      status: "failed",
      finished_at: now.toISOString(),
      error_code: "cellar_health_recompute_failed",
      error_message: "Cellar health recompute failed.",
    })
    .eq("id", jobId);
  if (error) throw new AggregateError([cause, error], "Failed to record cellar health job failure");
}
