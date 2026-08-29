/**
 * Map a scan-accuracy percentage (0–100) to a Tailwind text-color class.
 *
 * Thresholds mirror the manual-fallback logic in ./scoring.ts so the badge
 * colour matches the system's own confidence judgement:
 *   ≥ 90 (LOW_CONFIDENCE_AVG_THRESHOLD)  → clean scan
 *   ≥ 75 (LOW_CONFIDENCE_ITEM_THRESHOLD) → borderline, worth a review
 *   <  75                                → low confidence
 *
 * Three tokens, three readings, in both rooms. The middle step is the `mark`
 * rather than a fourth hue: DESIGN.md has four status colours and adding a
 * fifth would dilute the one that means "stop". It used to be `text-warning`
 * and `text-danger`, which both resolved to claret — and claret as TEXT on a
 * Nocturne ground is 3.24:1, below the floor for a 12px percentage.
 *
 * Used by the scan detail header, /scan recent-scans cards, and /insights
 * recent-activity rows so a glance at the percentage tells the operator
 * whether the scan was actually trustworthy.
 */
export function accuracyColor(percent: number): string {
  if (percent >= 90) return "text-ready-ink";
  if (percent >= 75) return "text-mark";
  return "text-risk-ink";
}
