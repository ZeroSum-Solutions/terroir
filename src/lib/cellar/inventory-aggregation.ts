export type CellarInventoryItem = {
  wine_id: string | null;
  bin_location: string | null;
  quantity: number | null;
  unit_cost: number | null;
  added_at: string | null;
  section: string | null;
  format: string | null;
};

export type CellarInventoryAggregate = {
  sealed: number;
  bin: string | null;
  section: string | null;
  averageUnitCost: number | null;
  lastPurchaseAt: string | null;
  formats: Array<{ format: string; quantity: number }>;
};

type MutableAggregate = {
  sealed: number;
  bin: string | null;
  section: string | null;
  weightedCost: number;
  costQuantity: number;
  lastPurchaseAt: string | null;
  formats: Map<string, number>;
};

function createAggregate(): MutableAggregate {
  return {
    sealed: 0,
    bin: null,
    section: null,
    weightedCost: 0,
    costQuantity: 0,
    lastPurchaseAt: null,
    formats: new Map<string, number>(),
  };
}

function isNewerPurchase(
  candidate: string | null,
  current: string | null,
): candidate is string {
  if (candidate === null) return false;
  if (current === null) return true;
  return candidate > current;
}

export function aggregateCellarInventory(
  rows: readonly CellarInventoryItem[],
): Map<string, CellarInventoryAggregate> {
  const aggregates = new Map<string, MutableAggregate>();

  for (const row of rows) {
    if (!row.wine_id) continue;
    const aggregate = aggregates.get(row.wine_id) ?? createAggregate();
    const quantity = row.quantity ?? 0;
    aggregate.sealed += quantity;

    if (isNewerPurchase(row.added_at, aggregate.lastPurchaseAt)) {
      aggregate.lastPurchaseAt = row.added_at;
      aggregate.bin = row.bin_location;
      aggregate.section = row.section;
    }

    if (row.unit_cost !== null && quantity > 0) {
      aggregate.weightedCost += row.unit_cost * quantity;
      aggregate.costQuantity += quantity;
    }

    if (quantity > 0) {
      const format = row.format?.trim() || "750ml";
      aggregate.formats.set(
        format,
        (aggregate.formats.get(format) ?? 0) + quantity,
      );
    }
    aggregates.set(row.wine_id, aggregate);
  }

  return new Map(
    Array.from(aggregates, ([wineId, aggregate]) => [
      wineId,
      {
        sealed: aggregate.sealed,
        bin: aggregate.bin,
        section: aggregate.section,
        averageUnitCost:
          aggregate.costQuantity > 0
            ? aggregate.weightedCost / aggregate.costQuantity
            : null,
        lastPurchaseAt: aggregate.lastPurchaseAt,
        formats: Array.from(
          aggregate.formats,
          ([format, quantity]) => ({ format, quantity }),
        ).sort((left, right) => left.format.localeCompare(right.format)),
      },
    ]),
  );
}
