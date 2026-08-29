import { isClosingWindow, isHolding } from "@/lib/drink-window/status";
import type { CellarUrlFilter } from "./url-state";

/**
 * The Cellar's query + chip-filter predicate.
 *
 * Extracted from CellarList (2026-08-29) when the Gallery view was added.
 * Both views read the same URL state, so if they each carried their own
 * copy of this predicate the two would eventually disagree about which
 * wines a given link shows — the sort of drift nobody notices until a
 * sommelier says "it's not in the grid but it's in the list".
 *
 * `applyFacets` (structured facets) and `sortCellarRows` (ordering) stay
 * where they are; this is only the free-text query and the single-select
 * chip filter, which is the part that was inline.
 */
export type CellarQueryRow = {
  name: string;
  producer: string;
  varietal: string | null;
  region: string | null;
  is_eightysixed: boolean;
  sealed_count: number;
  size_ml: number | null;
  open_remaining_ml: number | null;
  drink_window_start: number | null;
  drink_window_end: number | null;
};

/**
 * "off-site" exists in CellarList's own filter union and its label map but
 * in no URL contract, so it can never arrive from a link. It matched
 * nothing before this extraction and still matches nothing — preserved
 * rather than removed, since finishing or deleting the feature is a
 * separate decision.
 */
export type CellarFilterInput = CellarUrlFilter | "off-site";

export function applyCellarQueryFilter<T extends CellarQueryRow>(
  rows: readonly T[],
  query: string,
  filter: CellarFilterInput,
): T[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => matchesFilter(row, filter) && matchesQuery(row, q));
}

function matchesFilter(row: CellarQueryRow, filter: CellarFilterInput): boolean {
  switch (filter) {
    case "open":
      return row.open_remaining_ml !== null && row.open_remaining_ml > 0;
    case "out":
      return row.is_eightysixed;
    case "low": {
      // "Low" means under two full bottles of liquid, counting what's left
      // in an open one. A wine with no bottle size can't be measured that
      // way, so it is never low rather than always low.
      if (!row.size_ml) return false;
      if (row.is_eightysixed) return false;
      const totalMl = (row.open_remaining_ml ?? 0) + row.sealed_count * row.size_ml;
      return totalMl < 2 * row.size_ml;
    }
    case "off-site":
      return false;
    case "drink-now":
      return isClosingWindow(row.drink_window_end) && !row.is_eightysixed;
    case "hold":
      return isHolding(row.drink_window_start) && !row.is_eightysixed;
    case "all":
    default:
      return true;
  }
}

function matchesQuery(row: CellarQueryRow, q: string): boolean {
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) ||
    row.producer.toLowerCase().includes(q) ||
    (row.varietal ?? "").toLowerCase().includes(q) ||
    (row.region ?? "").toLowerCase().includes(q)
  );
}
