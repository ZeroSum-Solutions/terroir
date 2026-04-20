/**
 * Invoice scan quality scoring (BND-011).
 *
 * Extracted from /api/scan/route.ts. Pure function — no I/O, no env,
 * no platform deps — so it's trivially unit-testable.
 *
 * A scan "fails" (manualFallbackTriggered=true) when either:
 *   - average confidence across items is below 0.9 (low_confidence), or
 *   - the parser returned fewer than 3 items (too_few_items).
 *
 * When BOTH fire, reason is "both". The thresholds are behavioural and
 * reproduce /api/scan's behaviour before the extraction.
 */
import type { LineItem, ScanQuality } from "./types";

export const LOW_CONFIDENCE_ITEM_THRESHOLD = 0.75;
export const LOW_CONFIDENCE_AVG_THRESHOLD = 0.9;
export const MIN_ITEMS_BEFORE_FALLBACK = 3;

export function scoreItems(items: LineItem[]): ScanQuality {
  const avgConfidence =
    items.length > 0
      ? items.reduce((s, i) => s + i.confidence, 0) / items.length
      : 0;
  const lowConfidenceItems = items.filter(
    (i) => i.confidence < LOW_CONFIDENCE_ITEM_THRESHOLD,
  ).length;
  const lowConf = avgConfidence < LOW_CONFIDENCE_AVG_THRESHOLD;
  const tooFew = items.length < MIN_ITEMS_BEFORE_FALLBACK;

  return {
    avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    lowConfidenceItems,
    totalItems: items.length,
    manualFallbackTriggered: lowConf || tooFew,
    reason:
      lowConf && tooFew
        ? "both"
        : lowConf
          ? "low_confidence"
          : tooFew
            ? "too_few_items"
            : undefined,
  };
}
