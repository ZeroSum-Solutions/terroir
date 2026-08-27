import { facetCounts, type CellarFacetRow, type FacetCount } from "@/lib/cellar-facets";
import { lookupCountry, normalizeCountryText, UNMATCHED } from "./country-lookup";
import { WORLD_COUNTRY_PATHS } from "./world-paths.generated";

/** A cellar row plus whether it has a currently-open bottle. `hasOpenBottle`
 * is optional so plain CellarFacetRow[] (no open-bottle fetch) still
 * type-checks — those rows just fall back to sealed-count-only presence. */
export type AtlasFacetRow = CellarFacetRow & { hasOpenBottle?: boolean };

/** A wine only belongs on the Atlas map if it's actually in the cellar right
 * now: sealed stock, or a bottle currently open. A catalog row with neither
 * (86'd or fully depleted) must not inflate country/region counts. */
function hasCellarPresence(row: AtlasFacetRow): boolean {
  return row.sealed_count > 0 || row.hasOpenBottle === true;
}

// Mirrors cellar-facets' own text-equality contract (trim + locale-lowercase,
// src/lib/cellar-facets/index.ts's private normalize()) — the exact
// equivalence facetCounts uses to match a `country: rawLabel` facet. Kept as
// a local copy so rawLabels dedup below never diverges from what actually
// merges in a facetCounts() call.
function simpleTextKey(s: string): string {
  return s.trim().toLocaleLowerCase();
}

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
 *
 * A row with zero cellar presence (no sealed stock, no open bottle — a
 * catalog-only or fully-depleted wine) is excluded the same way: it never
 * counts toward either list.
 */
export function aggregateAtlasCountries(rows: readonly AtlasFacetRow[]): AtlasAggregate {
  const byKey = new Map<string, AtlasCountryAggregate>();
  const byUnmatched = new Map<string, AtlasUnmatchedAggregate>();

  for (const row of rows) {
    if (!hasCellarPresence(row)) continue;
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
    // Dedupe by the same trim+lowercase equality facetCounts uses, so
    // "France" and "france" never both land in rawLabels — merging both
    // into a region drill below would double-count every row (finding #8).
    if (!existing.rawLabels.some((label) => simpleTextKey(label) === simpleTextKey(raw))) {
      existing.rawLabels.push(raw);
    }
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
  rows: readonly AtlasFacetRow[],
  rawLabels: readonly string[],
): FacetCount[] {
  const presentRows = rows.filter(hasCellarPresence);
  // Dedupe defensively (aggregateAtlasCountries already dedupes rawLabels
  // before this is called, but two spellings that are equal under
  // facetCounts' text match — e.g. "France"/"france" — must never be
  // walked twice here either, or every region count doubles).
  const dedupedLabels = [...new Map(rawLabels.map((label) => [simpleTextKey(label), label])).values()];
  const merged = new Map<string, FacetCount>();
  for (const rawLabel of dedupedLabels) {
    for (const region of facetCounts(presentRows, { country: rawLabel }).region) {
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
