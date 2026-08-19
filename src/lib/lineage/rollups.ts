/**
 * OPP-1 — lineage grouping, rollups, and duplicate detection (client-safe,
 * pure). The cellar page groups its wine rows through these; the merge route
 * and /matching-style review surfaces consume `findDuplicateSuspects`.
 *
 * Invariants (EV-1.4, property-tested):
 *  - every wine lands in exactly one group;
 *  - rollups are exact sums of children;
 *  - cost basis is never averaged across vintage siblings — the rollup
 *    carries no blended per-bottle cost, and children keep their own.
 */

export type LineageWine = {
  id: string;
  lineageId: string | null;
  producer: string;
  name: string;
  vintage: number | null;
  sizeMl: number;
  quantity: number;
  value: number;
  unitCost: number | null;
};

export type LineageRollup = {
  totalQuantity: number;
  totalValue: number;
  /** [oldest, newest] across children with a vintage; null if none have one. */
  vintageSpan: [number, number] | null;
};

export type LineageGroup = {
  /** null for wines not linked to any lineage (each is its own group). */
  lineageId: string | null;
  /** Representative display fields, taken from the newest vintage. */
  producer: string;
  name: string;
  wines: LineageWine[];
  rollup: LineageRollup;
};

export type DuplicateSuspect = {
  lineageId: string;
  vintage: number | null;
  sizeMl: number;
  wineIds: string[];
};

function byVintageDesc(a: LineageWine, b: LineageWine): number {
  if (a.vintage == null && b.vintage == null) return a.id.localeCompare(b.id);
  if (a.vintage == null) return 1;
  if (b.vintage == null) return -1;
  return b.vintage - a.vintage;
}

function rollupOf(wines: LineageWine[]): LineageRollup {
  let totalQuantity = 0;
  let totalValue = 0;
  let min: number | null = null;
  let max: number | null = null;
  for (const w of wines) {
    totalQuantity += w.quantity;
    totalValue += w.value;
    if (w.vintage != null) {
      min = min == null ? w.vintage : Math.min(min, w.vintage);
      max = max == null ? w.vintage : Math.max(max, w.vintage);
    }
  }
  return {
    totalQuantity,
    totalValue,
    vintageSpan: min == null || max == null ? null : [min, max],
  };
}

export function groupByLineage(wines: LineageWine[]): LineageGroup[] {
  const byLineage = new Map<string, LineageWine[]>();
  const singletons: LineageWine[] = [];

  for (const wine of wines) {
    if (wine.lineageId == null) {
      singletons.push(wine);
      continue;
    }
    const bucket = byLineage.get(wine.lineageId);
    if (bucket) bucket.push(wine);
    else byLineage.set(wine.lineageId, [wine]);
  }

  const groups: LineageGroup[] = [];
  for (const [lineageId, members] of byLineage) {
    const sorted = [...members].sort(byVintageDesc);
    groups.push({
      lineageId,
      producer: sorted[0].producer,
      name: sorted[0].name,
      wines: sorted,
      rollup: rollupOf(sorted),
    });
  }
  for (const wine of singletons) {
    groups.push({
      lineageId: null,
      producer: wine.producer,
      name: wine.name,
      wines: [wine],
      rollup: rollupOf([wine]),
    });
  }
  return groups;
}

/**
 * EV-1.2: within one lineage, wines sharing vintage (NV treated as its own
 * bucket) and format are merge candidates. Wines with no lineage are never
 * paired — identity is unresolved, so "duplicate" is unprovable.
 */
export function findDuplicateSuspects(wines: LineageWine[]): DuplicateSuspect[] {
  const buckets = new Map<string, { meta: Omit<DuplicateSuspect, "wineIds">; ids: string[] }>();
  for (const w of wines) {
    if (w.lineageId == null) continue;
    const key = `${w.lineageId}|${w.vintage ?? "NV"}|${w.sizeMl}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.ids.push(w.id);
    else
      buckets.set(key, {
        meta: { lineageId: w.lineageId, vintage: w.vintage, sizeMl: w.sizeMl },
        ids: [w.id],
      });
  }
  const suspects: DuplicateSuspect[] = [];
  for (const { meta, ids } of buckets.values()) {
    if (ids.length > 1) suspects.push({ ...meta, wineIds: ids });
  }
  return suspects;
}
