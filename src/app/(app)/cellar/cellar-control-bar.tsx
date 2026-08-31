"use client";

import Link from "next/link";
import {
  LayoutGrid,
  List as ListIcon,
  SlidersHorizontal,
  Warehouse,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CellarCounters, type CellarCounterDef } from "./cellar-counters";
import type { CellarUrlFilter } from "@/lib/cellar-facets/url-state";

/**
 * CELLAR-01 / GLOBAL-01 — the Cellar's single control row.
 *
 * This replaces four stacked rows: the scope pills, the "bridge band"
 * (open-bottles link, search, voice, sort, view toggle, settings, reconcile),
 * the Producer/Region/Filters bar, and the standalone "Select wines" button.
 *
 * What survives here, and why:
 *   • Scope pills — the primary segment, and the thing a sommelier reaches for
 *     most. They scroll horizontally rather than wrapping, so this stays ONE
 *     row down to 320px.
 *   • The open-bottle cluster — contextual. Neither control renders when there
 *     is nothing open, which is how the row stays short in the common case.
 *   • Filters — one surface for every facet, plus sort, grouping and the
 *     select-wines mode. Producer and Region moved inside it.
 *   • View toggle — list or the bin grid.
 *   • Cellar settings — separated by a rule and carrying a visible label,
 *     because it is not a filter (CELLAR-01b: it used to be an icon-only
 *     button wearing the same sliders glyph as the real Filters control, and
 *     it opens a settings modal that is also the only route to
 *     /cellar/config).
 *
 * Search is deliberately NOT here: GLOBAL-02 exempts it from the one-row rule
 * and puts it above, on its own, at the top of the page.
 */
export function CellarControlBar({
  counters,
  activeFilter,
  onSelectFilter,
  activeFilterCount,
  onOpenFilters,
  openBottleCount,
  reconcileCount,
  onReconcile,
  view,
  onViewChange,
  showViewToggle,
  showSettings,
  onOpenSettings,
}: {
  counters: CellarCounterDef[];
  activeFilter: CellarUrlFilter;
  onSelectFilter: (filter: CellarUrlFilter) => void;
  /** Facets + sort + grouping currently applied, shown as a badge. */
  activeFilterCount: number;
  onOpenFilters: () => void;
  openBottleCount: number;
  /** Zero hides the reconcile action entirely — it is contextual. */
  reconcileCount: number;
  onReconcile: () => void;
  view: "list" | "grid";
  onViewChange: (view: "list" | "grid") => void;
  showViewToggle: boolean;
  showSettings: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div
      data-cellar-control-row
      className="-mx-md mb-md bg-surface-sunken px-md py-sm md:-mx-lg md:px-lg"
    >
      {/* One row, and it scrolls sideways rather than wrapping. The scope
          pills come FIRST so the primary segment is what a phone shows
          without scrolling; `ml-auto` still pushes the action cluster to the
          right wherever there is room for both. */}
      <div className="flex items-center gap-sm overflow-x-auto">
        <div className="shrink-0">
          <CellarCounters
            counters={counters}
            activeFilter={activeFilter}
            onSelect={onSelectFilter}
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-xs">
        {openBottleCount > 0 && (
          <Link
            href="/cellar/open"
            className="inline-flex h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-pill border border-edge px-md text-ledger font-medium text-ink hover:bg-surface/60 focus-ring"
          >
            Open bottles {openBottleCount}
          </Link>
        )}

        {reconcileCount > 0 && (
          <button
            type="button"
            onClick={onReconcile}
            className="inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-pill bg-primary px-md text-ledger font-medium text-seal-ink hover:bg-primary-hover focus-ring"
          >
            Reconcile {reconcileCount} open bottle
            {reconcileCount === 1 ? "" : "s"} →
          </button>
        )}

        <button
          type="button"
          onClick={onOpenFilters}
          className="inline-flex h-11 shrink-0 items-center gap-xs whitespace-nowrap rounded-pill border border-edge bg-surface px-sm text-ledger font-medium text-ink hover:bg-wash focus-ring"
        >
          <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          Filters
          {activeFilterCount > 0 && (
            <span className="tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-primary px-xs text-micro text-seal-ink">
              {activeFilterCount}
            </span>
          )}
        </button>

        {showViewToggle && (
          // Not `md:` — the bin grid is where "which bottle is in A5" gets
          // answered, and that question is asked standing in the cellar with a
          // phone. Hiding the only door to it below 768px made the grid, and
          // the wines inside it, unreachable there. This adds no ROW: the
          // control row scrolls sideways (GLOBAL-01 is about rows, not about
          // what fits without scrolling within one).
          <div className="inline-flex items-center overflow-hidden rounded-pill border border-edge">
            <ViewToggleButton
              active={view === "list"}
              onClick={() => onViewChange("list")}
              label="List"
              Icon={ListIcon}
            />
            <ViewToggleButton
              active={view === "grid"}
              onClick={() => onViewChange("grid")}
              label="Grid"
              Icon={LayoutGrid}
            />
          </div>
        )}

        {showSettings && (
          <>
            {/* Settings is not a filter. The rule keeps it out of the filter
                cluster visually as well as semantically. */}
            <span className="h-6 w-px shrink-0 bg-rule-strong" aria-hidden />
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex h-11 shrink-0 items-center gap-xs whitespace-nowrap rounded-pill px-sm text-ledger font-medium text-ink-soft hover:bg-surface/60 focus-ring"
            >
              <Warehouse className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              Cellar settings
            </button>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

function ViewToggleButton({
  active,
  onClick,
  label,
  Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label} view`}
      className={cn(
        "flex h-11 w-11 items-center justify-center text-ink-soft transition-colors",
        active && "bg-ink text-on-inverse",
        !active && "hover:bg-surface/60 focus-ring",
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
    </button>
  );
}
