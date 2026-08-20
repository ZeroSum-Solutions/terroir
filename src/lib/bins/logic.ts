export type BottleInventoryRow = {
  wineId: string;
  lineageId: string | null;
  name: string;
  producer: string;
  colour: string | null;
  binId: string | null;
  binCode: string | null;
  binZone: string | null;
  quantity: number;
};

export type BottleMatch = {
  wineId: string;
  name: string;
  producer: string;
  binId: string;
  binCode: string;
  binZone: string | null;
  quantity: number;
};

export type Bin = {
  id: string;
  code: string;
  zone: string | null;
  capacity: number | null;
  retiredAt: string | null;
};

export type PutAwayWine = {
  lineageId: string | null;
  colour: string | null;
};

export type PutAwaySuggestion = {
  binId: string;
  code: string;
  zone: string | null;
  reason: "same_lineage" | "same_colour_zone";
};

export function findBottleMatches(
  query: string,
  rows: readonly BottleInventoryRow[],
): BottleMatch[] {
  const needle = normalize(query);
  if (!needle) return [];

  const matches = new Map<string, BottleMatch>();
  for (const row of rows) {
    if (row.binId === null || row.binCode === null) continue;
    if (!normalize(row.name).includes(needle) && !normalize(row.producer).includes(needle)) continue;

    const key = `${row.wineId}\0${row.binId}`;
    const existing = matches.get(key);
    if (existing) {
      existing.quantity += row.quantity;
      continue;
    }
    matches.set(key, {
      wineId: row.wineId,
      name: row.name,
      producer: row.producer,
      binId: row.binId,
      binCode: row.binCode,
      binZone: row.binZone,
      quantity: row.quantity,
    });
  }
  return [...matches.values()];
}

export function suggestPutAway(input: {
  wine: Readonly<PutAwayWine>;
  inventoryRows: readonly BottleInventoryRow[];
  bins: readonly Bin[];
}): PutAwaySuggestion | null {
  const occupancy = totalOccupancy(input.inventoryRows);
  const eligible = input.bins.filter((candidate) => isEligible(candidate, occupancy));

  if (input.wine.lineageId !== null) {
    const lineageBins = new Set(
      input.inventoryRows
        .filter((row) => row.lineageId === input.wine.lineageId && row.binId !== null)
        .map((row) => row.binId as string),
    );
    const exact = eligible.find((candidate) => lineageBins.has(candidate.id));
    if (exact) return suggestion(exact, "same_lineage");
  }

  const colour = normalize(input.wine.colour);
  if (!colour) return null;
  const byId = new Map(input.bins.map((candidate) => [candidate.id, candidate]));
  const zoneTotals = sameColourZoneTotals(colour, input.inventoryRows, byId);
  let best: Bin | null = null;
  let bestTotal = 0;
  for (const candidate of eligible) {
    if (candidate.zone === null) continue;
    const total = zoneTotals.get(candidate.zone) ?? 0;
    if (total > bestTotal) {
      best = candidate;
      bestTotal = total;
    }
  }
  return best ? suggestion(best, "same_colour_zone") : null;
}

function normalize(value: string | null): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function totalOccupancy(rows: readonly BottleInventoryRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.binId === null) continue;
    totals.set(row.binId, (totals.get(row.binId) ?? 0) + row.quantity);
  }
  return totals;
}

function isEligible(candidate: Bin, occupancy: ReadonlyMap<string, number>): boolean {
  if (candidate.retiredAt !== null) return false;
  return candidate.capacity === null || (occupancy.get(candidate.id) ?? 0) < candidate.capacity;
}

function sameColourZoneTotals(
  colour: string,
  rows: readonly BottleInventoryRow[],
  binsById: ReadonlyMap<string, Bin>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.binId === null || normalize(row.colour) !== colour) continue;
    const zone = binsById.get(row.binId)?.zone;
    if (zone === null || zone === undefined) continue;
    totals.set(zone, (totals.get(zone) ?? 0) + row.quantity);
  }
  return totals;
}

function suggestion(bin: Bin, reason: PutAwaySuggestion["reason"]): PutAwaySuggestion {
  return { binId: bin.id, code: bin.code, zone: bin.zone, reason };
}
