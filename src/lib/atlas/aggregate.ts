import { facetCounts, type CellarFacetRow, type FacetCount } from "@/lib/cellar-facets";
import { lookupCountry, normalizeCountryText, UNMATCHED } from "./country-lookup";
import { WORLD_COUNTRY_PATHS } from "./world-paths.generated";

export type AtlasCountryAggregate = {
  /** world-paths.generated.ts key (ISO 3166-1 numeric). */
  key: string;
  /** World-atlas display name, used for the map's aria-label. */
  label: string;
  /** Distinct raw wines.country spellings that resolved to this key. */
  rawLabels: string[];
  bottles: number;
  wines: number;
};

export type AtlasUnmatchedAggregate = {
  /** The raw wines.country label as entered — surfaced verbatim, never dropped. */
  label: string;
  bottles: number;
  wines: number;
};

export type AtlasAggregate = {
  countries: AtlasCountryAggregate[];
  unmatched: AtlasUnmatchedAggregate[];
};

/**
 * Atlas v1 (recon lane "atlas-map") — groups the cellar's own rows by
 * resolved country for the map, honest about anything that didn't
 * resolve (UX-02 honest-data-states precedent: surface, never drop).
 *
 * A blank/null wines.country is treated as "no data", not "unmatched" —
 * it never produced a country label to fail to resolve in the first
 * place, so it's excluded from both lists (the page's own empty state
 * covers a cellar with no country data at all).
 */
export function aggregateAtlasCountries(rows: readonly CellarFacetRow[]): AtlasAggregate {
  const byKey = new Map<string, AtlasCountryAggregate>();
  const byUnmatched = new Map<string, AtlasUnmatchedAggregate>();

  for (const row of rows) {
    const raw = row.country?.trim();
    if (!raw) continue;

    const key = lookupCountry(raw);
    if (key === UNMATCHED) {
      const bucketKey = normalizeCountryText(raw);
      const existing = byUnmatched.get(bucketKey) ?? { label: raw, bottles: 0, wines: 0 };
      existing.bottles += row.sealed_count;
      existing.wines += 1;
      byUnmatched.set(bucketKey, existing);
      continue;
    }

    const existing = byKey.get(key) ?? {
      key,
      label: WORLD_COUNTRY_PATHS[key].name,
      rawLabels: [],
      bottles: 0,
      wines: 0,
    };
    if (!existing.rawLabels.includes(raw)) existing.rawLabels.push(raw);
    existing.bottles += row.sealed_count;
    existing.wines += 1;
    byKey.set(key, existing);
  }

  return {
    countries: [...byKey.values()].sort((a, b) => b.bottles - a.bottles),
    unmatched: [...byUnmatched.values()].sort((a, b) => b.bottles - a.bottles),
  };
}

/**
 * Region breakdown for one tapped country, for the Atlas bottom sheet.
 * Reuses facetCounts's existing country-scoped region grouping unchanged
 * (src/lib/cellar-facets/index.ts) — merges across `rawLabels` only for
 * the (uncommon) case where a country resolved from more than one raw
 * spelling in the same cellar.
 */
export function regionsForCountry(
  rows: readonly CellarFacetRow[],
  rawLabels: readonly string[],
): FacetCount[] {
  const merged = new Map<string, FacetCount>();
  for (const rawLabel of rawLabels) {
    for (const region of facetCounts(rows, { country: rawLabel }).region) {
      const existing = merged.get(region.value);
      merged.set(
        region.value,
        existing ? { ...existing, count: existing.count + region.count } : region,
      );
    }
  }
  return [...merged.values()].sort((a, b) => {
    if (a.isUnknown !== b.isUnknown) return a.isUnknown ? 1 : -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}
