/**
 * Cellar sort — the list had no sort control at all before the Kimi
 * audit (2026-08-26). Sorting is client-side over the already-filtered
 * rows; `null` keeps the server order (wine name A–Z).
 *
 * Pure and immutable: always returns a new array.
 */

export const CELLAR_SORTS = [
  "producer",
  "vintage-asc",
  "vintage-desc",
  "window",
  "qty-desc",
] as const;

export type CellarSort = (typeof CELLAR_SORTS)[number];

export const CELLAR_SORT_LABELS: Record<CellarSort, string> = {
  producer: "Producer A–Z",
  "vintage-asc": "Vintage · oldest first",
  "vintage-desc": "Vintage · newest first",
  window: "Window · closing first",
  "qty-desc": "Most bottles",
};

type SortableRow = {
  producer: string;
  name: string;
  vintage: number | null;
  drink_window_end: number | null;
  sealed_count: number;
  open_remaining_ml: number | null;
};

export function sortCellarRows<T extends SortableRow>(
  rows: T[],
  sort: CellarSort | null,
): T[] {
  if (!sort) return rows;
  const byName = (a: T, b: T) =>
    a.producer.localeCompare(b.producer) || a.name.localeCompare(b.name);
  const sorted = [...rows];
  switch (sort) {
    case "producer":
      sorted.sort((a, b) => byName(a, b) || (b.vintage ?? 0) - (a.vintage ?? 0));
      break;
    case "vintage-asc":
      // Null vintages (NV, unknown) sink to the end in both directions.
      sorted.sort(
        (a, b) =>
          (a.vintage ?? Infinity) - (b.vintage ?? Infinity) || byName(a, b),
      );
      break;
    case "vintage-desc":
      sorted.sort(
        (a, b) =>
          (b.vintage ?? -Infinity) - (a.vintage ?? -Infinity) || byName(a, b),
      );
      break;
    case "window":
      // Soonest-closing window first; wines without a window sink.
      sorted.sort(
        (a, b) =>
          (a.drink_window_end ?? Infinity) - (b.drink_window_end ?? Infinity) ||
          byName(a, b),
      );
      break;
    case "qty-desc":
      sorted.sort((a, b) => onHand(b) - onHand(a) || byName(a, b));
      break;
  }
  return sorted;
}

function onHand(row: SortableRow): number {
  const open = row.open_remaining_ml !== null && row.open_remaining_ml > 0 ? 1 : 0;
  return row.sealed_count + open;
}
