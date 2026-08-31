/**
 * BND-040 — Pricing intelligence status helpers.
 *
 * Pure, deterministic functions used by every pricing surface (Cellar
 * drawer Pricing section, Insights briefing pricing review, inline
 * editor popover, suggest-list-prices in AddWineModal). Single source
 * of truth so chip counts, list filters, alert triggers, and SQL
 * snooze filters can never drift.
 *
 * No external imports, no side effects. Mirrors `lib/drink-window/status.ts`
 * pattern (BND-039) for architectural consistency.
 *
 * Pricing terminology used throughout:
 *   • Pour cost % — (cost / glass price) × 100. Lower is better margin.
 *     Example: $20 cost, $90 glass → 22% pour cost.
 *   • Markup ratio — bottle list price / retail. Higher is more margin.
 *     Example: $230 bottle / $85 retail = 2.7× markup.
 *   • Glass cost-per-pour — (cost-per-bottle / size_ml) × glass_pour_ml
 *     Example: $85 / 750ml × 148ml = $16.77 cost per 5oz pour.
 *
 * Status taxonomy (consistent across surfaces):
 *   • on_target  — within ±10% of user target
 *   • tight      — pour cost % >= target (margin tighter than wanted)
 *   • premium    — markup or pour cost favorable beyond target band
 *   • outlier    — >20% deviation, worth a review
 *   • unknown    — missing data (no retail or no target)
 */

export type PricingStatus = "on_target" | "tight" | "premium" | "outlier" | "unknown";

/** Default house targets when restaurant hasn't customized yet. */
export const DEFAULT_TARGET_POUR_COST_PCT = 22.0;
export const DEFAULT_TARGET_MARKUP_RATIO = 2.7;

/** Deviation thresholds — stable across surfaces. */
export const ON_TARGET_DEVIATION_PCT = 10; // within ±10% of target = on target
export const OUTLIER_DEVIATION_PCT = 20; // >20% deviation = outlier worth review
const RETAIL_REFRESH_MAX_AGE_DAYS = 7; // retail cache TTL

/**
 * Floor below which a pour-cost target is not a pricing choice but a units
 * error. The column is a percentage (schema default 22.00, CHECK > 0 AND
 * < 100); a value like 0.24 is the same number written as a *fraction*, and
 * dividing by it inflates the suggestion exactly 100×. No real programme pours
 * at under 1% cost, so anything below this is unusable input rather than
 * arithmetic to honour.
 */
export const MIN_PLAUSIBLE_POUR_COST_PCT = 1.0;

/**
 * True when a pour-cost target (a percentage, not a fraction) is within the
 * plausible range — see `MIN_PLAUSIBLE_POUR_COST_PCT`. The single check
 * `suggestGlassPrice` and `resolvePourCostTarget` both apply, so an
 * implausible value like 0.24 can't yield a suggestion of null on one
 * surface while still driving the deviation/outlier calculation on the
 * other — the exact disagreement reviewer finding E flagged.
 */
export function isPlausiblePourCostTarget(
  value: number | null | undefined,
): value is number {
  return value != null && value >= MIN_PLAUSIBLE_POUR_COST_PCT && value < 100;
}

/**
 * Compute pour cost % for a glass pour.
 *
 * @param costPerBottle - what we paid (invoice cost or median retail) — dollars
 * @param sizeMl        - bottle size, default 750
 * @param glassPourMl   - pour size in ml (per BND-038 wine_list_items.glass_pour_ml)
 * @param glassPrice    - what we charge for the glass — dollars
 * @returns pour cost % (0-100) or null when inputs missing
 */
export function getPourCostPct(
  costPerBottle: number | null | undefined,
  sizeMl: number | null | undefined,
  glassPourMl: number | null | undefined,
  glassPrice: number | null | undefined,
): number | null {
  if (
    costPerBottle == null ||
    glassPourMl == null ||
    glassPrice == null ||
    glassPrice <= 0 ||
    !sizeMl ||
    sizeMl <= 0 ||
    glassPourMl <= 0
  ) {
    return null;
  }
  const costPerPour = (costPerBottle / sizeMl) * glassPourMl;
  return (costPerPour / glassPrice) * 100;
}

/**
 * Compute markup ratio (bottle list / retail).
 *
 * @returns ratio (e.g. 2.7) or null when retail or list missing
 */
export function getMarkupRatio(
  bottleList: number | null | undefined,
  retailReference: number | null | undefined,
): number | null {
  if (
    bottleList == null ||
    retailReference == null ||
    retailReference <= 0 ||
    bottleList <= 0
  ) {
    return null;
  }
  return bottleList / retailReference;
}

/**
 * Suggest a bottle list price given a target markup ratio + retail reference.
 * Used by AddWineModal's Suggest List Prices step.
 *
 * @returns suggested dollar price rounded to nearest dollar, or null when inputs missing
 */
export function suggestBottlePrice(
  retailReference: number | null | undefined,
  targetMarkupRatio: number | null | undefined,
): number | null {
  if (
    retailReference == null ||
    targetMarkupRatio == null ||
    retailReference <= 0 ||
    targetMarkupRatio <= 0
  ) {
    return null;
  }
  return Math.round(retailReference * targetMarkupRatio);
}

/**
 * Suggest a glass price given a target pour cost % + cost-per-bottle + glass pour size.
 * cost-per-bottle is invoice cost when known, else median retail.
 *
 * The lower bound on `targetPourCostPct` is load-bearing, not defensive
 * boilerplate. The old bound was `> 0`, which let a fraction through: the local
 * seed held 0.24 where the column means 24, and the app rendered a suggested
 * glass price of **$7,203** — arithmetically correct, exactly 100× wrong, and
 * shown to the user with a straight face. A suggestion nobody can act on is
 * worse than no suggestion, so an implausible target now yields null and the
 * row falls back to a dash.
 *
 * @returns suggested dollar price rounded to nearest dollar, or null when
 *   inputs are missing or the target is outside the plausible range
 */
export function suggestGlassPrice(
  costPerBottle: number | null | undefined,
  sizeMl: number | null | undefined,
  glassPourMl: number | null | undefined,
  targetPourCostPct: number | null | undefined,
): number | null {
  if (
    costPerBottle == null ||
    glassPourMl == null ||
    !sizeMl ||
    sizeMl <= 0 ||
    glassPourMl <= 0 ||
    !isPlausiblePourCostTarget(targetPourCostPct)
  ) {
    return null;
  }
  const costPerPour = (costPerBottle / sizeMl) * glassPourMl;
  // costPerPour / glassPrice = targetPourCostPct/100
  // → glassPrice = costPerPour × 100 / targetPourCostPct
  return Math.round((costPerPour * 100) / targetPourCostPct);
}

/**
 * Classify a wine's bottle pricing relative to user target.
 *
 * @param actualMarkup     - current bottle markup ratio (or null if no retail)
 * @param targetMarkup     - user's target markup
 */
export function getBottleStatus(
  actualMarkup: number | null,
  targetMarkup: number | null,
): PricingStatus {
  if (actualMarkup == null || targetMarkup == null) return "unknown";
  const deviationPct = Math.abs(((actualMarkup - targetMarkup) / targetMarkup) * 100);
  if (deviationPct <= ON_TARGET_DEVIATION_PCT) return "on_target";
  if (actualMarkup < targetMarkup) {
    return deviationPct > OUTLIER_DEVIATION_PCT ? "outlier" : "tight";
  }
  // actualMarkup > targetMarkup — sommelier earning more than target
  return deviationPct > OUTLIER_DEVIATION_PCT ? "outlier" : "premium";
}

/**
 * Classify a wine's glass pricing relative to user pour cost target.
 *
 * Lower pour cost % = higher margin = "premium"
 * Higher pour cost % = tighter margin = "tight"
 */
export function getGlassStatus(
  actualPourCostPct: number | null,
  targetPourCostPct: number | null,
): PricingStatus {
  if (actualPourCostPct == null || targetPourCostPct == null) return "unknown";
  const deviationPct = Math.abs(
    ((actualPourCostPct - targetPourCostPct) / targetPourCostPct) * 100,
  );
  if (deviationPct <= ON_TARGET_DEVIATION_PCT) return "on_target";
  if (actualPourCostPct > targetPourCostPct) {
    return deviationPct > OUTLIER_DEVIATION_PCT ? "outlier" : "tight";
  }
  // actualPourCostPct < targetPourCostPct — better margin than target.
  // Reviewer-find C1: extreme favorable outliers also flag for review —
  // could be missed pricing opportunity OR wrong-wine cost basis from a
  // bad LWIN match. Prior code returned "premium" in both branches,
  // swallowing the signal.
  return deviationPct > OUTLIER_DEVIATION_PCT ? "outlier" : "premium";
}

/**
 * True when a wine should appear in the Insights pricing-review alert
 * — outlier in either direction, AND not currently snoozed.
 *
 * Single source of truth: both the SQL alerts query and the in-memory
 * filter consume this predicate via shared helpers.
 */
export function isPricingOutlier(
  bottleStatus: PricingStatus,
  glassStatus: PricingStatus,
): boolean {
  return bottleStatus === "outlier" || glassStatus === "outlier";
}

/**
 * True when the snooze (pricing_dismissed_until) has expired or is null.
 * Used by alerts.ts (SQL filter) AND by the in-memory deviation filter
 * so chip counts and alerts can't disagree about who's snoozed.
 */
export function isSnoozeActive(
  pricingDismissedUntil: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!pricingDismissedUntil) return false;
  const until = new Date(pricingDismissedUntil);
  return until.getTime() > now.getTime();
}

/**
 * True when retail cache is stale and needs refresh. UI can show a soft
 * "Last refreshed N days ago" badge or trigger a refresh on next request.
 */
export function isRetailStale(
  retailRefreshedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!retailRefreshedAt) return true;
  const refreshed = new Date(retailRefreshedAt);
  const ageMs = now.getTime() - refreshed.getTime();
  return ageMs > RETAIL_REFRESH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Sanity-check Wine-Searcher response price against invoice cost. The
 * trial-tier API can return wrong-wine collisions on LWIN ambiguity;
 * this filter drops outliers (price < 0.1× or > 10× invoice cost).
 *
 * Architect-review finding 5 (BND-040 plan audit).
 */
export function isRetailPlausible(
  retailPrice: number,
  invoiceCost: number | null | undefined,
): boolean {
  if (invoiceCost == null || invoiceCost <= 0) return true; // no anchor — accept
  const ratio = retailPrice / invoiceCost;
  return ratio >= 0.1 && ratio <= 10;
}

/**
 * A glass must cost less than the whole bottle it is poured from.
 *
 * Second line of defence behind `suggestGlassPrice`'s target floor, and the one
 * that does not depend on knowing *why* the number is wrong: whatever produced
 * it — a bad target, a bad size_ml, a bad cost — a glass priced at or above the
 * bottle is not a suggestion anyone can use.
 *
 * Same shape as `isRetailPlausible` above: no anchor to compare against means
 * accept, because refusing on missing data would suppress good suggestions.
 */
export function isGlassPricePlausible(
  glassPrice: number | null,
  bottleReference: number | null | undefined,
): boolean {
  if (glassPrice == null) return true; // nothing to judge
  if (bottleReference == null || bottleReference <= 0) return true; // no anchor
  return glassPrice < bottleReference;
}

/**
 * Position of the bottle list price along the target band axis (0-100%).
 * Used by the PriceBand visual component. The band is centered on the
 * target markup × retail reference, with ±20% bounds.
 *
 * @returns 0-100 (clamped) or 0 when inputs missing
 */
export function getBandMarkerPosition(
  bottleList: number | null,
  retailReference: number | null,
  targetMarkup: number | null,
): number {
  if (bottleList == null || retailReference == null || targetMarkup == null) return 0;
  const targetPrice = retailReference * targetMarkup;
  const minPrice = targetPrice * 0.7; // axis low bound
  const maxPrice = targetPrice * 1.3; // axis high bound
  const span = maxPrice - minPrice;
  if (span <= 0) return 50;
  const offset = bottleList - minPrice;
  return Math.max(0, Math.min(100, (offset / span) * 100));
}

/**
 * Human-readable label for status pills.
 */
export function formatPricingStatusLabel(status: PricingStatus): string {
  switch (status) {
    case "on_target":
      return "On target";
    case "tight":
      return "Tight margin";
    case "premium":
      return "Above target";
    case "outlier":
      return "Outlier";
    case "unknown":
    default:
      return "—";
  }
}

/**
 * Resolve effective pour-cost target: per-wine override > restaurant default > house fallback.
 *
 * An implausible stored value (finding E: the same 0.24-as-fraction bug
 * `suggestGlassPrice` guards against) is treated as absent rather than
 * returned raw — otherwise a bad per-wine or restaurant value would produce
 * a null suggestion (dash) while still driving `getGlassStatus`'s deviation
 * math into flagging the row as an outlier, two surfaces disagreeing about
 * the same number.
 */
export function resolvePourCostTarget(
  perWineTarget: number | null | undefined,
  restaurantDefault: number | null | undefined,
): number {
  if (isPlausiblePourCostTarget(perWineTarget)) return perWineTarget;
  if (isPlausiblePourCostTarget(restaurantDefault)) return restaurantDefault;
  return DEFAULT_TARGET_POUR_COST_PCT;
}

/**
 * Resolve effective markup target: per-wine override > restaurant default > house fallback.
 * Category-aware band can override this when applied — see category-bands.ts.
 */
export function resolveMarkupTarget(
  perWineTarget: number | null | undefined,
  restaurantDefault: number | null | undefined,
): number {
  if (perWineTarget != null) return perWineTarget;
  if (restaurantDefault != null) return restaurantDefault;
  return DEFAULT_TARGET_MARKUP_RATIO;
}
