/**
 * Map a scan-accuracy percentage (0–100) to a Tailwind text-color class.
 *
 * Thresholds mirror the manual-fallback logic in ./scoring.ts so the
 * badge colour matches the system's own confidence judgement:
 *   ≥ 90 (LOW_CONFIDENCE_AVG_THRESHOLD)  → success — clean scan
 *   ≥ 75 (LOW_CONFIDENCE_ITEM_THRESHOLD) → warning — borderline, worth a review
 *   <  75                                 → danger  — low confidence
 *
 * Used by the scan detail header, /scan recent-scans cards, and
 * /insights recent-activity rows so a glance at the percentage tells
 * the operator whether the scan was actually trustworthy.
 */
export function accuracyColor(percent: number): string {
  if (percent >= 90) return "text-success";
  if (percent >= 75) return "text-warning";
  return "text-danger";
}
