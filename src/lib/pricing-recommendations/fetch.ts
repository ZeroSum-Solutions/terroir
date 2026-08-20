import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HEALTH_SEGMENTS } from "@/lib/cellar-health/classify";
import type { Database } from "@/types/database";
import {
  DAYS_OF_WEEK,
  PRICING_RECOMMENDATION_CLASSES,
} from "./recommend";

const EvidenceSchema = z.object({
  healthSegment: z.enum(HEALTH_SEGMENTS).nullable(),
  appreciation: z.number().nullable(),
  appreciationThreshold: z.number(),
  velocity30d: z.number().int().nonnegative(),
  marginPct: z.number().nullable(),
  marginThresholdPct: z.number(),
  dayOfWeekProfile: z.partialRecord(
    z.enum(DAYS_OF_WEEK),
    z.number().int().nonnegative(),
  ),
  selectedDay: z.enum(DAYS_OF_WEEK).nullable(),
});

const WineSchema = z.object({
  name: z.string().min(1),
  producer: z.string().min(1),
  vintage: z.number().int().nullable(),
});

const StoredRowSchema = z.object({
  wine_id: z.uuid(),
  class: z.enum(PRICING_RECOMMENDATION_CLASSES),
  rationale: z.string().trim().min(1),
  evidence: EvidenceSchema,
  timing: z.string().trim().min(1).nullable(),
  // PostgREST serializes timestamptz with a +00:00 offset, not Z.
  computed_at: z.iso.datetime({ offset: true }),
  wines: z.union([WineSchema, z.array(WineSchema).min(1).max(1)]),
});

export type PricingPlay = {
  wineId: string;
  class: z.infer<typeof StoredRowSchema>["class"];
  rationale: string;
  evidence: z.infer<typeof EvidenceSchema>;
  timing: string | null;
  computedAt: string;
  wine: z.infer<typeof WineSchema>;
};

export async function fetchPricingRecommendations(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
): Promise<PricingPlay[]> {
  const pageSize = 1000;
  const all: unknown[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("pricing_recommendations")
      .select(
        "wine_id, class, rationale, evidence, timing, computed_at, wines!inner(name, producer, vintage)",
      )
      .eq("restaurant_id", restaurantId)
      .order("class")
      .order("computed_at", { ascending: false })
      .order("wine_id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
  }

  return StoredRowSchema.array().parse(all).map((row) => ({
    wineId: row.wine_id,
    class: row.class,
    rationale: row.rationale,
    evidence: row.evidence,
    timing: row.timing,
    computedAt: row.computed_at,
    wine: Array.isArray(row.wines) ? row.wines[0] : row.wines,
  }));
}
