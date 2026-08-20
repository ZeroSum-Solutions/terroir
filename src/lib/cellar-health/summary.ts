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
