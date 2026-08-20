export const UNKNOWN_FACET_VALUE = "__unknown__";

export type FacetDimension =
  | "producer"
  | "region"
  | "country"
  | "varietal"
  | "vintage"
  | "format";

export type CellarGroupBy = "producer" | "region" | "varietal" | "vintage";

export type CellarFacets = {
  producer?: string | null;
  region?: string | null;
  country?: string | null;
  varietal?: string | null;
  vintageMin?: number | null;
  vintageMax?: number | null;
  format?: number | null;
  health?: CellarHealthSegment | null;
};

export type CellarFacetRow = {
  wine_id: string;
  producer: string;
  region: string | null;
  country: string | null;
  varietal: string | null;
  vintage: number | null;
  wine_size_ml: number;
  sealed_count: number;
  healthSegment: CellarHealthSegment | null;
};

export type FacetCount = { value: string; label: string; count: number; isUnknown: boolean };
export type FacetCounts = Record<FacetDimension, FacetCount[]>;

export type CellarFacetGroup<T extends CellarFacetRow = CellarFacetRow> = {
  key: string;
  label: string;
  wineCount: number;
  totalBottles: number;
  wines: T[];
};

const TEXT_DIMENSIONS = ["producer", "region", "country", "varietal"] as const;

export function applyFacets<T extends CellarFacetRow>(
  rows: readonly T[],
  facets: CellarFacets,
): T[] {
  return rows.filter((row) => {
    if (facets.health && row.healthSegment !== facets.health) return false;
    for (const dimension of TEXT_DIMENSIONS) {
      if (!matchesText(row[dimension], facets[dimension])) return false;
    }
    if (facets.vintageMin != null && (row.vintage == null || row.vintage < facets.vintageMin)) {
      return false;
    }
    if (facets.vintageMax != null && (row.vintage == null || row.vintage > facets.vintageMax)) {
      return false;
    }
    return facets.format == null || row.wine_size_ml === facets.format;
  });
}

export function facetCounts<T extends CellarFacetRow>(
  rows: readonly T[],
  facets: CellarFacets,
): FacetCounts {
  return {
    producer: countDimension(applyFacets(rows, omitDimension(facets, "producer")), "producer"),
    region: countDimension(applyFacets(rows, omitDimension(facets, "region")), "region"),
    country: countDimension(applyFacets(rows, omitDimension(facets, "country")), "country"),
    varietal: countDimension(applyFacets(rows, omitDimension(facets, "varietal")), "varietal"),
    vintage: countDimension(applyFacets(rows, omitDimension(facets, "vintage")), "vintage"),
    format: countDimension(applyFacets(rows, omitDimension(facets, "format")), "format"),
  };
}

export function groupRows<T extends CellarFacetRow>(
  rows: readonly T[],
  groupBy: CellarGroupBy,
): Array<CellarFacetGroup<T>> {
  const buckets = new Map<string, { label: string; wines: T[] }>();
  for (const row of rows) {
    const raw = groupValue(row, groupBy);
    const key = raw === null ? UNKNOWN_FACET_VALUE : "v:" + normalize(raw);
    const label = raw === null ? "Unknown" : raw;
    const bucket = buckets.get(key) ?? { label, wines: [] };
    bucket.wines.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      wineCount: bucket.wines.length,
      totalBottles: bucket.wines.reduce((total, row) => total + row.sealed_count, 0),
      wines: bucket.wines,
    }))
    .sort((left, right) => compareGroups(left, right, groupBy));
}

function matchesText(value: string | null, expected: string | null | undefined) {
  if (!expected) return true;
  return value != null && normalize(value) === normalize(expected);
}

function omitDimension(facets: CellarFacets, dimension: FacetDimension): CellarFacets {
  const next = { ...facets };
  if (dimension === "vintage") {
    delete next.vintageMin;
    delete next.vintageMax;
  } else {
    delete next[dimension];
  }
  return next;
}

function countDimension<T extends CellarFacetRow>(
  rows: readonly T[],
  dimension: FacetDimension,
): FacetCount[] {
  const counts = new Map<string, FacetCount>();
  for (const row of rows) {
    const raw = dimensionValue(row, dimension);
    const isUnknown = raw === null;
    const key = isUnknown ? UNKNOWN_FACET_VALUE : "v:" + normalize(raw);
    const current = counts.get(key);
    if (current) current.count += 1;
    else {
      counts.set(key, {
        value: isUnknown ? UNKNOWN_FACET_VALUE : raw,
        label: isUnknown ? "Unknown" : raw,
        count: 1,
        isUnknown,
      });
    }
  }
  return [...counts.values()].sort((left, right) => compareCounts(left, right, dimension));
}

function dimensionValue(row: CellarFacetRow, dimension: FacetDimension): string | null {
  if (dimension === "vintage") return row.vintage == null ? null : String(row.vintage);
  if (dimension === "format") return String(row.wine_size_ml);
  const value = row[dimension];
  return value?.trim() ? value : null;
}

function groupValue(row: CellarFacetRow, groupBy: CellarGroupBy): string | null {
  if (groupBy === "vintage") return row.vintage == null ? null : String(row.vintage);
  const value = row[groupBy];
  return value?.trim() ? value : null;
}

function compareCounts(left: FacetCount, right: FacetCount, dimension: FacetDimension) {
  if (left.isUnknown !== right.isUnknown) return left.isUnknown ? 1 : -1;
  if (dimension === "vintage") return Number(right.value) - Number(left.value);
  if (dimension === "format") return Number(left.value) - Number(right.value);
  return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
}

function compareGroups(
  left: { key: string; label: string },
  right: { key: string; label: string },
  groupBy: CellarGroupBy,
) {
  if (left.key === UNKNOWN_FACET_VALUE) return 1;
  if (right.key === UNKNOWN_FACET_VALUE) return -1;
  if (groupBy === "vintage") return Number(right.label) - Number(left.label);
  return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase();
}
import type { CellarHealthSegment } from "@/lib/cellar-health/classify";
