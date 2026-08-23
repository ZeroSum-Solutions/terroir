"use client";

import { cn } from "@/lib/utils";
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
  const counters: CellarCounterDef[] = [
    { id: "all", label: "All", value: alerts.totalBottles.toLocaleString() },
    { id: "open", label: "Open", value: alerts.openCount },
    { id: "out", label: "86'd", value: alerts.outCount },
    { id: "low", label: "Low stock", value: alerts.lowCount },
  ];
  if (alerts.drinkNowCount > 0) {
    counters.push({ id: "drink-now", label: "Drink now", value: alerts.drinkNowCount });
  }
  if (alerts.holdCount > 0) {
    counters.push({ id: "hold", label: "Hold", value: alerts.holdCount });
  }
  return counters;
}

export function CellarCounters({
  counters,
  activeFilter,
  onSelect,
}: {
  counters: CellarCounterDef[];
  activeFilter: CellarUrlFilter;
  onSelect: (filter: CellarUrlFilter) => void;
}) {
  return (
    <div role="tablist" aria-label="Cellar counters" className="flex flex-wrap gap-xs">
      {counters.map((counter) => {
        const selected = activeFilter === counter.id;
        return (
          <button
            key={counter.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(counter.id)}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-xs whitespace-nowrap rounded-pill px-md transition-opacity",
              // `.glass` sets background/border/box-shadow as unlayered CSS
              // (see globals.css) so it always wins over Tailwind's layered
              // bg-*/border-*/shadow-*/ring-* utilities — never combine it
              // with one of those. Selected state therefore uses a fully
              // separate (non-glass) class branch, and focus goes through
              // `outline`, which glass never touches.
              selected
                ? "border border-ink bg-ink text-beige focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-beige"
                : "glass text-ink hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            )}
          >
            <span
              className={cn(
                "text-[10.5px] font-medium uppercase tracking-[0.14em]",
                selected ? "text-beige/70" : "text-grey",
              )}
            >
              {counter.label}
            </span>
            <span
              className={cn(
                "font-serif text-[17px] leading-none",
                selected ? "text-beige" : "text-ink",
              )}
            >
              {counter.value}
            </span>
          </button>
        );
      })}
    </div>
  );
}
