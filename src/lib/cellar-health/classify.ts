export const HEALTH_SEGMENTS = [
  "window_risk",
  "hold",
  "dead_stock",
  "cash_trap",
  "healthy",
] as const;

export type CellarHealthSegment = (typeof HEALTH_SEGMENTS)[number];

export type CellarHealthThresholds = {
  deadStockDays: number;
  cashTrapFloor: number;
  appreciationThreshold: number;
};

export const DEFAULT_HEALTH_THRESHOLDS: CellarHealthThresholds = {
  deadStockDays: 120,
  cashTrapFloor: 500,
  appreciationThreshold: 0.08,
};

export type CellarHealthInput = {
  drinkWindowStart: number | null;
  drinkWindowEnd: number | null;
  /** Bottles on hand — window_risk keys off stock, not monetary value. */
  stockQuantity: number;
  stockValue: number;
  lastMovementAt: string | null;
  appreciation: number | null;
};

export type CellarHealthResult = {
  segment: CellarHealthSegment;
  reason: string;
};

export function classifyCellarHealth(
  input: CellarHealthInput,
  thresholds: CellarHealthThresholds,
  today: Date = new Date(),
): CellarHealthResult {
  const year = today.getUTCFullYear();
  const window = resolveWindow(input.drinkWindowStart, input.drinkWindowEnd);
  const inFinalThird = window !== null && year >= window.finalThirdStart;
  const insideWindow = window !== null && year >= window.start && year <= window.end;
  const appreciating =
    input.appreciation !== null &&
    input.appreciation >= thresholds.appreciationThreshold;
  const stale = isStale(input.lastMovementAt, thresholds.deadStockDays, today);

  if (window && inFinalThird && input.stockQuantity > 0) {
    return result("window_risk", `entered the final third of ${window.start}–${window.end}`);
  }
  if (window && insideWindow && appreciating) {
    return result(
      "hold",
      `inside its drink window with appreciation at or above ${formatPercent(thresholds.appreciationThreshold)}`,
    );
  }
  if (!inFinalThird && stale && !appreciating) {
    return result(
      "dead_stock",
      `no movement for at least ${thresholds.deadStockDays} days and no qualifying appreciation`,
    );
  }
  if (input.stockValue >= thresholds.cashTrapFloor && stale) {
    return result(
      "cash_trap",
      `stock value is at least $${thresholds.cashTrapFloor} with no movement for ${thresholds.deadStockDays} days`,
    );
  }
  return result("healthy", "no risk or hold rule fired");
}

export function deriveAppreciation(
  marketPrice: number | null,
  weightedUnitCost: number | null,
): number | null {
  if (marketPrice === null || weightedUnitCost === null || weightedUnitCost <= 0) {
    return null;
  }
  return marketPrice / weightedUnitCost - 1;
}

export function isCellarHealthSegment(value: string): value is CellarHealthSegment {
  return (HEALTH_SEGMENTS as readonly string[]).includes(value);
}

function resolveWindow(start: number | null, end: number | null) {
  if (start === null || end === null || start > end) return null;
  return { start, end, finalThirdStart: start + ((end - start) * 2) / 3 };
}

function isStale(lastMovementAt: string | null, days: number, today: Date) {
  if (!lastMovementAt) return true;
  const timestamp = new Date(lastMovementAt).getTime();
  if (Number.isNaN(timestamp)) return true;
  return today.getTime() - timestamp >= days * 86_400_000;
}

function result(segment: CellarHealthSegment, detail: string): CellarHealthResult {
  return { segment, reason: `${segment} rule: ${detail}.` };
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}
