import {
  suggestPutAway,
  type Bin,
  type BottleInventoryRow,
  type PutAwaySuggestion,
} from "@/lib/bins/logic";

type CellarBinWine = {
  id: string;
  lineageId: string | null;
  name: string;
  producer: string;
  colour: string | null;
};

type CellarInventoryPlacement = {
  wineId: string;
  binId: string | null;
  quantity: number;
};

export type CellarBinPlacement = {
  binId: string;
  code: string;
  zone: string | null;
  quantity: number;
};

export type CellarBinData = {
  placements: CellarBinPlacement[];
  unplacedCount: number;
  suggestedBin: PutAwaySuggestion | null;
};

function toBottleRows(
  wines: readonly CellarBinWine[],
  bins: readonly Bin[],
  inventoryRows: readonly CellarInventoryPlacement[],
): BottleInventoryRow[] {
  const winesById = new Map(wines.map((wine) => [wine.id, wine]));
  const binsById = new Map(bins.map((bin) => [bin.id, bin]));
  return inventoryRows.flatMap((item) => {
    const wine = winesById.get(item.wineId);
    if (!wine) return [];
    const bin = item.binId ? binsById.get(item.binId) : null;
    if (item.binId && !bin) return [];
    return [{
      wineId: wine.id,
      lineageId: wine.lineageId,
      name: wine.name,
      producer: wine.producer,
      colour: wine.colour,
      binId: bin?.id ?? null,
      binCode: bin?.code ?? null,
      binZone: bin?.zone ?? null,
      quantity: item.quantity,
    }];
  });
}

function groupWineStock(rows: readonly BottleInventoryRow[]) {
  const grouped = new Map<string, {
    placements: Map<string, CellarBinPlacement>;
    unplacedCount: number;
  }>();
  for (const row of rows) {
    const stock = grouped.get(row.wineId) ?? {
      placements: new Map<string, CellarBinPlacement>(),
      unplacedCount: 0,
    };
    if (!row.binId || !row.binCode) {
      stock.unplacedCount += row.quantity;
    } else {
      const prior = stock.placements.get(row.binId);
      stock.placements.set(row.binId, {
        binId: row.binId,
        code: row.binCode,
        zone: row.binZone,
        quantity: (prior?.quantity ?? 0) + row.quantity,
      });
    }
    grouped.set(row.wineId, stock);
  }
  return grouped;
}

export function buildCellarBinData(input: {
  wines: readonly CellarBinWine[];
  bins: readonly Bin[];
  inventoryRows: readonly CellarInventoryPlacement[];
}): Record<string, CellarBinData> {
  const bottleRows = toBottleRows(input.wines, input.bins, input.inventoryRows);
  const grouped = groupWineStock(bottleRows);
  return Object.fromEntries(input.wines.map((wine) => {
    const stock = grouped.get(wine.id);
    const unplacedCount = stock?.unplacedCount ?? 0;
    const suggestedBin = unplacedCount > 0
      ? suggestPutAway({ wine, inventoryRows: bottleRows, bins: input.bins })
      : null;
    return [wine.id, {
      placements: [...(stock?.placements.values() ?? [])],
      unplacedCount,
      suggestedBin,
    }];
  }));
}
