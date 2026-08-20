import type { CellarHealthSegment } from "@/lib/cellar-health/classify";

export const PRICING_RECOMMENDATION_CLASSES = [
  "discount_to_move",
  "raise_appreciating",
  "feature_btg",
  "hold",
] as const;

export type PricingRecommendationClass =
  (typeof PRICING_RECOMMENDATION_CLASSES)[number];

export const DAYS_OF_WEEK = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];
export type DayOfWeekProfile = Partial<Record<DayOfWeek, number>>;

export type PricingRecommendationInput = {
  wineId: string;
  healthSegment: CellarHealthSegment | null;
  /** Market comparable relative to weighted cost basis. 0.08 means +8%. */
  appreciation: number | null;
  /** Count of positive pour events in the trailing 30 days. */
  velocity: number;
  /** Best available gross margin percentage from current list prices. */
  marginPct: number | null;
  dayOfWeekProfile: DayOfWeekProfile;
};

export type PricingRecommendationThresholds = {
  appreciation: number;
  featureMarginPct: number;
  staleVelocity: number;
};

export const DEFAULT_PRICING_THRESHOLDS: PricingRecommendationThresholds = {
  appreciation: 0.08,
  featureMarginPct: 70,
  staleVelocity: 0,
};

export type PricingRecommendationEvidence = {
  healthSegment: CellarHealthSegment | null;
  appreciation: number | null;
  appreciationThreshold: number;
  velocity30d: number;
  marginPct: number | null;
  marginThresholdPct: number;
  dayOfWeekProfile: DayOfWeekProfile;
  selectedDay: DayOfWeek | null;
};

export type PricingRecommendation = {
  wineId: string;
  class: PricingRecommendationClass;
  rationale: string;
  evidence: PricingRecommendationEvidence;
  timing: string | null;
};

/**
 * Pricing rule order is a safety property. Appreciating wines and explicit
 * cellar-health holds resolve before any movement rule, so they cannot reach
 * discount_to_move (the Meursault rule).
 *
 * Feature timing uses the slowest observed UTC weekday for this wine in the
 * supplied pour history. Missing days are unknown, not zero-demand days. Ties
 * resolve Monday through Sunday. Restaurant timezone is not stored today, so
 * UTC keeps recomputes deterministic.
 */
export function recommendPricing(
  input: PricingRecommendationInput,
  thresholds: PricingRecommendationThresholds = DEFAULT_PRICING_THRESHOLDS,
): PricingRecommendation {
  const slowestDay = selectSlowestObservedDay(input.dayOfWeekProfile);
  const evidence = buildEvidence(input, thresholds, slowestDay);
  // Keep these nullish checks in safety order. Protected wines resolve first.
  return (
    appreciatingRecommendation(input, thresholds, evidence) ??
    explicitHoldRecommendation(input, evidence) ??
    featureRecommendation(input, thresholds, slowestDay, evidence) ??
    discountRecommendation(input, thresholds, evidence) ??
    recommendation(
      input.wineId,
      "hold",
      "Current margin, movement, and market evidence do not support a price change.",
      evidence,
    )
  );
}

function appreciatingRecommendation(
  input: PricingRecommendationInput,
  thresholds: PricingRecommendationThresholds,
  evidence: PricingRecommendationEvidence,
) {
  if (
    input.appreciation === null ||
    input.appreciation < thresholds.appreciation
  ) return null;
  return recommendation(
    input.wineId,
    "raise_appreciating",
    `Market comparable is ${formatPercent(input.appreciation)} above cost basis. Review the bottle price.`,
    evidence,
  );
}

function explicitHoldRecommendation(
  input: PricingRecommendationInput,
  evidence: PricingRecommendationEvidence,
) {
  if (input.healthSegment !== "hold") return null;
  return recommendation(
    input.wineId,
    "hold",
    "Cellar health marks this wine as a hold. No pricing action is recommended.",
    evidence,
  );
}

function featureRecommendation(
  input: PricingRecommendationInput,
  thresholds: PricingRecommendationThresholds,
  slowestDay: DayOfWeek | null,
  evidence: PricingRecommendationEvidence,
) {
  if (
    input.marginPct === null ||
    input.marginPct < thresholds.featureMarginPct ||
    slowestDay === null
  ) return null;
  return recommendation(
    input.wineId,
    "feature_btg",
    `${Math.round(input.marginPct)}% gross margin supports a by-the-glass feature on the slowest observed day.`,
    evidence,
    `Feature BTG ${slowestDay}`,
  );
}

function discountRecommendation(
  input: PricingRecommendationInput,
  thresholds: PricingRecommendationThresholds,
  evidence: PricingRecommendationEvidence,
) {
  const segment = input.healthSegment;
  const stale = segment === "dead_stock" || segment === "cash_trap";
  if (!stale || input.velocity > thresholds.staleVelocity) return null;
  return recommendation(
    input.wineId,
    "discount_to_move",
    `No pours in 30 days and cellar health marks this wine as ${segment.replace("_", " ")}.`,
    evidence,
  );
}

export function recommendPricingPortfolio(
  inputs: readonly PricingRecommendationInput[],
  thresholds: PricingRecommendationThresholds = DEFAULT_PRICING_THRESHOLDS,
) {
  return inputs.map((input) => recommendPricing(input, thresholds));
}

function selectSlowestObservedDay(profile: DayOfWeekProfile): DayOfWeek | null {
  let selected: DayOfWeek | null = null;
  let minimum = Number.POSITIVE_INFINITY;
  for (const day of DAYS_OF_WEEK) {
    const count = profile[day];
    // Presence means observed: an explicit zero-demand day is a valid
    // (in fact ideal) slowest day; only absent days are unknown.
    if (count === undefined || count < 0 || count >= minimum) continue;
    selected = day;
    minimum = count;
  }
  return selected;
}

function buildEvidence(
  input: PricingRecommendationInput,
  thresholds: PricingRecommendationThresholds,
  selectedDay: DayOfWeek | null,
): PricingRecommendationEvidence {
  return {
    healthSegment: input.healthSegment,
    appreciation: input.appreciation,
    appreciationThreshold: thresholds.appreciation,
    velocity30d: input.velocity,
    marginPct: input.marginPct,
    marginThresholdPct: thresholds.featureMarginPct,
    dayOfWeekProfile: { ...input.dayOfWeekProfile },
    selectedDay,
  };
}

function recommendation(
  wineId: string,
  recommendationClass: PricingRecommendationClass,
  rationale: string,
  evidence: PricingRecommendationEvidence,
  timing: string | null = null,
): PricingRecommendation {
  return { wineId, class: recommendationClass, rationale, evidence, timing };
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}
