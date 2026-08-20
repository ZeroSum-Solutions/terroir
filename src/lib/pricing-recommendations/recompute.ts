import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  isCellarHealthSegment,
} from "@/lib/cellar-health/classify";
import { getMarkupRatio, getPourCostPct } from "@/lib/pricing/status";
import type { Database } from "@/types/database";
import {
  DAYS_OF_WEEK,
  PRICING_RECOMMENDATION_CLASSES,
  recommendPricingPortfolio,
  type DayOfWeek,
  type DayOfWeekProfile,
  type PricingRecommendationClass,
  type PricingRecommendationInput,
} from "./recommend";

type Client = SupabaseClient<Database>;
type RecommendationInsert =
  Database["public"]["Tables"]["pricing_recommendations"]["Insert"];

export type PricingRecommendationsRecomputeResult = {
  recommended: number;
  classes: Record<PricingRecommendationClass, number>;
};

export async function runPricingRecommendationsRecompute(
  admin: Client,
  restaurantId: string,
  userId: string,
  now: Date = new Date(),
): Promise<PricingRecommendationsRecomputeResult> {
  const jobId = await startJob(admin, restaurantId, userId, now);
  try {
    const inputs = await loadInputs(admin, restaurantId, now);
    const rows = buildRows(inputs, restaurantId, now);
    // Upsert, stale cleanup, and job finish are separate commits (no RPC).
    // Accepted limitation, same as cellar_health: this is advisory state and
    // an idempotent rerun self-heals a partially-visible generation.
    for (let start = 0; start < rows.length; start += WRITE_BATCH_SIZE) {
      const { error } = await admin
        .from("pricing_recommendations")
        .upsert(rows.slice(start, start + WRITE_BATCH_SIZE), {
          onConflict: "restaurant_id,wine_id",
        });
      if (error) throw error;
    }
    await removeStaleRows(admin, restaurantId, inputs.existingWineIds, rows);
    const classes = countClasses(rows);
    await finishJob(admin, jobId, new Date(), rows.length, classes);
    return { recommended: rows.length, classes };
  } catch (error) {
    await failJob(admin, jobId, new Date(), error);
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
      job_type: "pricing_recommendations",
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

const FETCH_PAGE_SIZE = 1_000;
const PROFILE_DAYS = 90;
const WRITE_BATCH_SIZE = 500;
const VELOCITY_DAYS = 30;

async function fetchAll<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += FETCH_PAGE_SIZE) {
    const { data, error } = await makeQuery(from, from + FETCH_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < FETCH_PAGE_SIZE) return rows;
  }
}

async function loadInputs(admin: Client, restaurantId: string, now: Date) {
  const profileSince = new Date(now.getTime() - PROFILE_DAYS * 86_400_000);
  const [wines, inventory, health, pours, listItems, config, existing] =
    await Promise.all([
      fetchAll((from, to) => admin.from("wines").select("id, retail_median, size_ml").eq("restaurant_id", restaurantId).order("id").range(from, to)),
      fetchAll((from, to) => admin.from("inventory_items").select("id, wine_id, quantity, unit_cost").eq("restaurant_id", restaurantId).order("id").range(from, to)),
      fetchAll((from, to) => admin.from("cellar_health").select("wine_id, segment").eq("restaurant_id", restaurantId).order("wine_id").range(from, to)),
      fetchAll((from, to) => admin.from("pour_events").select("id, wine_id, kind, ml_delta, occurred_at").eq("restaurant_id", restaurantId).gte("occurred_at", profileSince.toISOString()).lte("occurred_at", now.toISOString()).order("id").range(from, to)),
      fetchAll((from, to) => admin.from("wine_list_items").select("id, wine_id, bottle_price, glass_price, glass_pour_ml, wine_list_sections!inner(wine_lists!inner(restaurant_id))").eq("wine_list_sections.wine_lists.restaurant_id", restaurantId).order("id").range(from, to)),
      admin.from("cellar_config").select("health_appreciation_threshold").eq("restaurant_id", restaurantId).limit(1).maybeSingle(),
      fetchAll((from, to) => admin.from("pricing_recommendations").select("wine_id").eq("restaurant_id", restaurantId).order("wine_id").range(from, to)),
    ]);
  if (config.error) throw config.error;
  return {
    wines,
    inventory,
    health,
    pours,
    listItems,
    appreciationThreshold:
      config.data?.health_appreciation_threshold ??
      DEFAULT_HEALTH_THRESHOLDS.appreciationThreshold,
    existingWineIds: existing.map((row) => row.wine_id),
    now,
  };
}

type LoadedInputs = Awaited<ReturnType<typeof loadInputs>>;

function buildRows(
  inputs: LoadedInputs,
  restaurantId: string,
  now: Date,
): RecommendationInsert[] {
  const stock = aggregateStock(inputs.inventory);
  const segments = aggregateSegments(inputs.health);
  const activity = aggregateActivity(inputs.pours, now);
  const margins = aggregateMargins(
    inputs.listItems,
    stock,
    inputs.wines,
    restaurantId,
  );
  const recommendations = recommendPricingPortfolio(
    inputs.wines.flatMap((wine) => {
      const basis = stock.get(wine.id);
      if (!basis || basis.quantity <= 0) return [];
      const marketRatio = getMarkupRatio(wine.retail_median, basis.unitCost);
      const wineActivity = activity.get(wine.id);
      return [{
        wineId: wine.id,
        healthSegment: segments.get(wine.id) ?? null,
        appreciation: marketRatio === null ? null : marketRatio - 1,
        velocity: wineActivity?.velocity ?? 0,
        marginPct: margins.get(wine.id) ?? null,
        dayOfWeekProfile: wineActivity?.profile ?? {},
      } satisfies PricingRecommendationInput];
    }),
    {
      appreciation: inputs.appreciationThreshold,
      featureMarginPct: 70,
      staleVelocity: 0,
    },
  );
  return recommendations.map((row) => ({
    restaurant_id: restaurantId,
    wine_id: row.wineId,
    class: row.class,
    rationale: row.rationale,
    evidence: row.evidence,
    timing: row.timing,
    computed_at: now.toISOString(),
  }));
}

function aggregateStock(rows: LoadedInputs["inventory"]) {
  const totals = new Map<string, { quantity: number; value: number }>();
  for (const row of rows) {
    const current = totals.get(row.wine_id) ?? { quantity: 0, value: 0 };
    current.quantity += row.quantity;
    current.value += row.quantity * row.unit_cost;
    totals.set(row.wine_id, current);
  }
  return new Map(
    [...totals].map(([wineId, value]) => [
      wineId,
      { quantity: value.quantity, unitCost: value.value / value.quantity },
    ]),
  );
}

function aggregateSegments(rows: LoadedInputs["health"]) {
  const result = new Map<string, PricingRecommendationInput["healthSegment"]>();
  for (const row of rows) {
    if (isCellarHealthSegment(row.segment)) result.set(row.wine_id, row.segment);
  }
  return result;
}

function aggregateActivity(rows: LoadedInputs["pours"], now: Date) {
  const velocitySince = now.getTime() - VELOCITY_DAYS * 86_400_000;
  const result = new Map<string, { velocity: number; profile: DayOfWeekProfile }>();
  for (const row of rows) {
    if (row.kind !== "pour" || row.ml_delta <= 0) continue;
    const timestamp = new Date(row.occurred_at);
    if (timestamp.getTime() > now.getTime()) continue; // future-dated rows never count
    if (Number.isNaN(timestamp.getTime())) continue;
    const current = result.get(row.wine_id) ?? { velocity: 0, profile: {} };
    if (timestamp.getTime() >= velocitySince) current.velocity += 1;
    const day = dayFromUtc(timestamp);
    current.profile[day] = (current.profile[day] ?? 0) + 1;
    result.set(row.wine_id, current);
  }
  return result;
}

function aggregateMargins(
  rawRows: LoadedInputs["listItems"],
  stock: ReturnType<typeof aggregateStock>,
  wines: LoadedInputs["wines"],
  restaurantId: string,
) {
  const sizeByWine = new Map(wines.map((wine) => [wine.id, wine.size_ml]));
  const result = new Map<string, number>();
  for (const row of rawRows as unknown as ListItemRow[]) {
    const basis = stock.get(row.wine_id);
    if (!basis || !belongsToRestaurant(row, restaurantId)) continue;
    const margins = listItemMargins(row, basis.unitCost, sizeByWine.get(row.wine_id));
    for (const margin of margins) {
      if (margin > (result.get(row.wine_id) ?? Number.NEGATIVE_INFINITY)) {
        result.set(row.wine_id, margin);
      }
    }
  }
  return result;
}

type ListItemRow = {
  wine_id: string;
  bottle_price: number | null;
  glass_price: number | null;
  glass_pour_ml: number | null;
  wine_list_sections: { wine_lists: { restaurant_id: string } | { restaurant_id: string }[] } | Array<{ wine_lists: { restaurant_id: string } | { restaurant_id: string }[] }>;
};

function belongsToRestaurant(row: ListItemRow, restaurantId: string) {
  const section = Array.isArray(row.wine_list_sections)
    ? row.wine_list_sections[0]
    : row.wine_list_sections;
  const list = Array.isArray(section?.wine_lists)
    ? section.wine_lists[0]
    : section?.wine_lists;
  return list?.restaurant_id === restaurantId;
}

function listItemMargins(row: ListItemRow, unitCost: number, sizeMl?: number) {
  if (!Number.isFinite(unitCost) || unitCost <= 0) return [];
  const margins: number[] = [];
  const pourCost = getPourCostPct(
    unitCost,
    sizeMl,
    row.glass_pour_ml,
    row.glass_price,
  );
  if (pourCost !== null) margins.push(100 - pourCost);
  const markup = getMarkupRatio(row.bottle_price, unitCost);
  if (markup !== null) margins.push(((markup - 1) / markup) * 100);
  return margins;
}

function dayFromUtc(date: Date): DayOfWeek {
  return DAYS_OF_WEEK[(date.getUTCDay() + 6) % 7];
}

function countClasses(rows: RecommendationInsert[]) {
  const counts = Object.fromEntries(
    PRICING_RECOMMENDATION_CLASSES.map((value) => [value, 0]),
  ) as Record<PricingRecommendationClass, number>;
  for (const row of rows) counts[row.class as PricingRecommendationClass] += 1;
  return counts;
}

async function removeStaleRows(
  admin: Client,
  restaurantId: string,
  existingWineIds: string[],
  currentRows: RecommendationInsert[],
) {
  const current = new Set(currentRows.map((row) => row.wine_id));
  const stale = existingWineIds.filter((wineId) => !current.has(wineId));
  for (let start = 0; start < stale.length; start += WRITE_BATCH_SIZE) {
    const { error } = await admin
      .from("pricing_recommendations")
      .delete()
      .eq("restaurant_id", restaurantId)
      .in("wine_id", stale.slice(start, start + WRITE_BATCH_SIZE));
    if (error) throw error;
  }
}

async function finishJob(
  admin: Client,
  jobId: string,
  now: Date,
  recommended: number,
  classes: Record<PricingRecommendationClass, number>,
) {
  const { error } = await admin
    .from("background_jobs")
    .update({
      status: "succeeded",
      finished_at: now.toISOString(),
      result: { recommended, classes },
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
      error_code: "pricing_recommendations_recompute_failed",
      error_message: "Pricing recommendations recompute failed.",
    })
    .eq("id", jobId);
  if (error) {
    throw new AggregateError(
      [cause, error],
      "Failed to record pricing recommendations job failure",
    );
  }
}
