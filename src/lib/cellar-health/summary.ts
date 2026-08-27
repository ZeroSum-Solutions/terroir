import {
  HEALTH_SEGMENTS,
  isCellarHealthSegment,
  type CellarHealthSegment,
} from "./classify";

export type CellarHealthSummaryItem = {
  segment: CellarHealthSegment;
  count: number;
  value: number;
};

type HealthRow = { wine_id: string; segment: string };
type InventoryRow = { wine_id: string; quantity: number; unit_cost: number };

export function summarizeCellarHealth(
  healthRows: readonly HealthRow[],
  inventoryRows: readonly InventoryRow[],
): CellarHealthSummaryItem[] {
  const segmentByWine = new Map<string, CellarHealthSegment>();
  for (const row of healthRows) {
    if (isCellarHealthSegment(row.segment)) {
      segmentByWine.set(row.wine_id, row.segment);
    }
  }

  const stockByWine = new Map<string, { quantity: number; value: number }>();
  for (const row of inventoryRows) {
    const stock = stockByWine.get(row.wine_id) ?? { quantity: 0, value: 0 };
    stock.quantity += row.quantity;
    stock.value += row.quantity * row.unit_cost;
    stockByWine.set(row.wine_id, stock);
  }

  const summary = new Map(
    HEALTH_SEGMENTS.map((segment) => [segment, { segment, count: 0, value: 0 }]),
  );
  for (const [wineId, stock] of stockByWine) {
    const segment = segmentByWine.get(wineId);
    if (!segment || stock.quantity <= 0) continue;
    const item = summary.get(segment)!;
    item.count += 1;
    item.value += stock.value;
  }
  return HEALTH_SEGMENTS.map((segment) => summary.get(segment)!);
}

/**
 * Stocked wines with no (valid) cellar_health row. These silently vanished
 * from every segment, so the health cards could read "$0 / 0 wines" beside
 * a six-figure snapshot total (Kimi audit 2026-08-26). Surfacing the bucket
 * makes the segmentation reconcile with the inventory it claims to cover.
 */
export function summarizeUnscoredStock(
  healthRows: readonly HealthRow[],
  inventoryRows: readonly InventoryRow[],
): { count: number; value: number } {
  const scored = new Set<string>();
  for (const row of healthRows) {
    if (isCellarHealthSegment(row.segment)) scored.add(row.wine_id);
  }

  const stockByWine = new Map<string, { quantity: number; value: number }>();
  for (const row of inventoryRows) {
    const stock = stockByWine.get(row.wine_id) ?? { quantity: 0, value: 0 };
    stock.quantity += row.quantity;
    stock.value += row.quantity * row.unit_cost;
    stockByWine.set(row.wine_id, stock);
  }

  let count = 0;
  let value = 0;
  for (const [wineId, stock] of stockByWine) {
    if (scored.has(wineId) || stock.quantity <= 0) continue;
    count += 1;
    value += stock.value;
  }
  return { count, value };
}
