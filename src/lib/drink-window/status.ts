/**
 * BND-039 — drink window status helpers.
 *
 * Pure, deterministic functions used by every drink-window surface
 * (Cellar list filter chip, Cellar drawer panel, Insights briefing
 * alert). Single source of truth so the chip-count, list-filter,
 * and alert-trigger predicates can never drift.
 *
 * No imports, no side effects, fully tested.
 *
 * Status definitions (consistent across surfaces):
 *   • hold      — drink_window_start is in the future
 *   • optimal   — current_year is within (start, end - 2)
 *   • drink_now — current_year is within end - 2 ≤ y ≤ end
 *   • past_peak — current_year is past drink_window_end
 *   • unknown   — start or end is null
 */

export type DrinkStatus = "hold" | "optimal" | "drink_now" | "past_peak" | "unknown";

export const DRINK_NOW_THRESHOLD_YEARS = 2;
const ALERT_TRIGGER_YEARS = 1;

/**
 * Classify a wine's current state given its drink window.
 *
 * @param start - drink_window_start (year, e.g. 2018) or null
 * @param end   - drink_window_end   (year, e.g. 2030) or null
 * @param currentYear - defaults to today's year. Override for tests/SSR.
 */
export function getDrinkWindowStatus(
  start: number | null | undefined,
  end: number | null | undefined,
  currentYear: number = new Date().getFullYear(),
): DrinkStatus {
  if (start == null || end == null) return "unknown";
  if (currentYear < start) return "hold";
  if (currentYear > end) return "past_peak";
  if (end - currentYear <= DRINK_NOW_THRESHOLD_YEARS) return "drink_now";
  return "optimal";
}

/**
 * Years remaining until the drink window closes. Negative if past peak.
 * Returns null when end is unknown.
 */
export function getYearsUntilWindowClose(
  end: number | null | undefined,
  currentYear: number = new Date().getFullYear(),
): number | null {
  if (end == null) return null;
  return end - currentYear;
}

/**
 * Position of the current year along the drink window axis, as a
 * percentage 0-100 (clamped). Used by the timeline component to place
 * the marker. Returns 0 when window is unknown.
 *
 * The math intentionally allows the marker to sit at 0 (current_year =
 * start) or 100 (current_year = end). For wines past peak we clamp to
 * 100 so the marker is visible on the rightmost edge.
 */
export function getMarkerPosition(
  start: number | null | undefined,
  end: number | null | undefined,
  currentYear: number = new Date().getFullYear(),
): number {
  if (start == null || end == null) return 0;
  if (start === end) return 50; // degenerate single-year window
  const span = end - start;
  const offset = currentYear - start;
  const pct = (offset / span) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * True when a wine should appear in the "Drink now" filter chip — i.e.
 * within the last `thresholdYears` of its window OR past peak (since
 * past-peak is also "drink it before it gets worse").
 *
 * Default threshold (2 years) matches the chip predicate in the spec.
 */
export function isClosingWindow(
  end: number | null | undefined,
  thresholdYears: number = DRINK_NOW_THRESHOLD_YEARS,
  currentYear: number = new Date().getFullYear(),
): boolean {
  if (end == null) return false;
  return end - currentYear <= thresholdYears;
}

/**
 * True when a wine qualifies for the Insights briefing alert — within
 * `ALERT_TRIGGER_YEARS` of window close. Tighter than `isClosingWindow`
 * because alerts are more aggressive than the filter chip.
 *
 * Snooze checking happens at the API layer (filters out wines whose
 * `alert_snoozed_until` is in the future).
 */
export function shouldTriggerAlert(
  end: number | null | undefined,
  currentYear: number = new Date().getFullYear(),
): boolean {
  if (end == null) return false;
  const yearsLeft = end - currentYear;
  return yearsLeft <= ALERT_TRIGGER_YEARS;
}

/**
 * True when a wine is in its hold phase (start is in the future).
 * Powers the "Hold" filter chip.
 */
export function isHolding(
  start: number | null | undefined,
  currentYear: number = new Date().getFullYear(),
): boolean {
  if (start == null) return false;
  return start > currentYear;
}

/**
 * Years until the drink window opens. Positive while holding, zero or
 * negative once open. Returns null when start is unknown.
 */
export function getYearsUntilWindowOpen(
  start: number | null | undefined,
  currentYear: number = new Date().getFullYear(),
): number | null {
  if (start == null) return null;
  return start - currentYear;
}

/**
 * Human-readable status label for chips and pills. Renders the same
 * verbiage shown in the mock.
 *
 * `yearsUntilStart` feeds ONLY the hold label ("ready in N yrs"). It used
 * to be derived from `Math.abs(yearsLeft)` — years until the window
 * CLOSES — so a 2030–2040 wine claimed "ready in 14 yrs" instead of 4
 * (Kimi audit follow-up, 2026-08-26). Callers without the start year get
 * a plain "Hold".
 */
export function formatStatusLabel(
  status: DrinkStatus,
  yearsLeft: number | null,
  yearsUntilStart: number | null = null,
): string {
  switch (status) {
    case "hold":
      return yearsUntilStart != null && yearsUntilStart > 0
        ? `Hold · ready in ${yearsUntilStart} yr${yearsUntilStart === 1 ? "" : "s"}`
        : "Hold";
    case "drink_now":
      if (yearsLeft == null) return "Drink now";
      // yearsLeft === 0 → final year of optimal window.
      // yearsLeft  <  0 → already past optimal (shouldn't happen via
      // status flow since past_peak wins, but defensive). Distinct
      // labels because "final year" and "past optimal" mean different
      // things to a sommelier. Code-quality-review finding 7.
      if (yearsLeft === 0) return "Drink now · final year";
      if (yearsLeft < 0) return "Drink now · past optimal";
      return `Drink now · ${yearsLeft} yr${yearsLeft === 1 ? "" : "s"} left`;
    case "past_peak":
      return "Past peak";
    case "optimal":
      return "Optimal";
    case "unknown":
    default:
      return "—";
  }
}
