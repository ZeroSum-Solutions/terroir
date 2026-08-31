"use client";

import { type CellarUrlFilter } from "@/lib/cellar-facets/url-state";

export type CellarCounterAlerts = {
  totalBottles: number;
  openCount: number;
  outCount: number;
  lowCount: number;
  drinkNowCount: number;
  holdCount: number;
};

export type CellarCounterDef = {
  id: CellarUrlFilter;
  label: string;
  value: string | number;
};

/**
 * M2-15 §2.3 — counters-as-navigation.
 *
 * Before this slice, the hero showed a row of read-only glass stat tiles
 * (bottles on hand / drink now / low stock / 86'd) and the bridge band
 * below repeated three of those same counts as a separate row of filter
 * chips — plus a fourth chip ("Open") duplicated again by the standalone
 * "Open bottles" link. Tapping a hero tile did nothing; tapping the chip
 * below it applied the filter. This builds ONE list of counters that are
 * simultaneously the KPI display and the filter navigation, collapsing
 * the tile grid and the chip row into a single on-screen representation.
 * The one exception is "Open bottles": it stays as its own link in the
 * utility row because it points somewhere genuinely different — a
 * dedicated close-out page, not this list filtered to open wines — so
 * its count still appears twice on the page by design, not by omission.
 */
export function buildCellarCounters(alerts: CellarCounterAlerts): CellarCounterDef[] {
  // Zero-count counters are suppressed (Kimi audit 2026-08-26): they are
  // filters, and a filter to nothing is noise — "LOW STOCK 0" was styled
  // identically to the service-urgent counts. "All" always renders.
  const counters: CellarCounterDef[] = [
    { id: "all", label: "All", value: alerts.totalBottles.toLocaleString() },
  ];
  if (alerts.openCount > 0) {
    counters.push({ id: "open", label: "Open", value: alerts.openCount });
  }
  if (alerts.outCount > 0) {
    counters.push({ id: "out", label: "86'd", value: alerts.outCount });
  }
  if (alerts.lowCount > 0) {
    counters.push({ id: "low", label: "Low stock", value: alerts.lowCount });
  }
  if (alerts.drinkNowCount > 0) {
    counters.push({ id: "drink-now", label: "Drink now", value: alerts.drinkNowCount });
  }
  if (alerts.holdCount > 0) {
    counters.push({ id: "hold", label: "Hold", value: alerts.holdCount });
  }
  return counters;
}

/**
 * GLOBAL-01 / CELLAR-01 — the scope control, as ONE control.
 *
 * These counters used to render as a strip of pills. Measured on the seeded
 * cellar at 390px (e2e/cellar-control-row.test.ts), four of them are 424px
 * wide before the gaps, against 354px of usable row — so three of the row's
 * ten controls were on screen and seven sat behind 740px of sideways scroll
 * inside an `overflow-x-auto`. The page reported no horizontal overflow the
 * whole time, because the row absorbed it.
 *
 * The fix is not a breakpoint. The pill strip's width is DATA-dependent: four
 * counters here, six on a cellar with low stock and holds (~670px), and no
 * media query can know which. A `<select>` is constant-width whatever the
 * data, so it is the only form of this control that fits by construction —
 * and it is the rule's own answer, six buttons becoming one.
 *
 * Nothing is lost: every counter's number is in its option, and the active
 * one is on screen at all times, which is what the pills showed.
 */
export function CellarScopeSelect({
  counters,
  activeFilter,
  onSelect,
}: {
  counters: CellarCounterDef[];
  activeFilter: CellarUrlFilter;
  onSelect: (filter: CellarUrlFilter) => void;
}) {
  return (
    <select
      aria-label="Cellar scope"
      value={activeFilter}
      onChange={(event) => onSelect(event.target.value as CellarUrlFilter)}
      // `min-w-0 flex-1` makes this the row's ONLY flexible control: every
      // other one is `shrink-0`, so the scope select absorbs whatever width
      // is left and the row cannot overflow while the fixed controls fit.
      className="h-11 min-w-0 flex-1 truncate rounded-pill border border-edge bg-surface px-sm text-ledger font-medium text-ink hover:bg-wash focus-ring sm:max-w-[220px]"
    >
      {counters.map((counter) => (
        <option key={counter.id} value={counter.id}>
          {counter.label} · {counter.value}
        </option>
      ))}
    </select>
  );
}
