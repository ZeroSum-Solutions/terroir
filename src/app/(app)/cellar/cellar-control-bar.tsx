"use client";

import Link from "next/link";
import {
  LayoutGrid,
  List as ListIcon,
  SlidersHorizontal,
  Warehouse,
  Wine,
} from "lucide-react";
import { OverflowMenu, type OverflowMenuItem } from "@/components/overflow-menu";
import { CellarScopeSelect, type CellarCounterDef } from "./cellar-counters";
import type { CellarUrlFilter } from "@/lib/cellar-facets/url-state";

/**
 * CELLAR-01 / GLOBAL-01 — the Cellar's single control row, and every control
 * in it inside the frame.
 *
 * This replaced four stacked rows. It then spent a release failing the other
 * half of the same rule: measured at 390px it held TEN controls, of which
 * three were on screen and seven sat 740px off to the right inside an
 * `overflow-x-auto`. Both gates passed — the static ratchet counts rows, and
 * the page's own `scrollWidth` never grew because the row swallowed the
 * overflow. "If you cannot fit all the buttons horizontally in one frame,
 * then there are too many buttons" is a claim about controls, not about
 * containers, so the row no longer scrolls: what does not fit is demoted.
 *
 * Measured at 390px, usable row width 354px:
 *   scope pills   424px (4 counters; ~670px with 6)  → ONE select
 *   Open bottles  118px  ┐
 *   Reconcile     173px  ├ contextual, `sm:`+ pills; on a phone they are the
 *   Cellar sett.  124px  ┘ first entries of the overflow menu
 *   Filters        86px  → stays: it is the page's one facet surface
 *   List|Grid      88px  → ONE toggle button, 44px, labelled for the view it
 *                          switches TO (CELLAR-08 keeps the bin grid reachable
 *                          on a phone, so it cannot be demoted into the menu —
 *                          a menu item is not visible until the menu opens)
 *   ────────────────────
 *   phone total   ~318px of 354px, with the scope select absorbing the slack.
 *
 * Search is deliberately NOT here: GLOBAL-02 exempts it from the rule and puts
 * it above, on its own, at the top of the page.
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
  const reconcileLabel = `Reconcile ${reconcileCount} open bottle${
    reconcileCount === 1 ? "" : "s"
  }`;

  // `sm:hidden` on the demoted pair, so an action is never offered twice in
  // the same frame: on a phone it is here, from 640px up it is a pill in the
  // row and this entry is display:none.
  const menuItems: OverflowMenuItem[] = [
    ...(openBottleCount > 0
      ? [
          {
            label: `Open bottles ${openBottleCount}`,
            Icon: Wine,
            href: "/cellar/open",
            className: "sm:hidden",
          },
        ]
      : []),
    ...(reconcileCount > 0
      ? [
          {
            label: reconcileLabel,
            Icon: ListIcon,
            onSelect: onReconcile,
            className: "sm:hidden",
          },
        ]
      : []),
    ...(showSettings
      ? [{ label: "Cellar settings", Icon: Warehouse, onSelect: onOpenSettings }]
      : []),
  ];

  return (
    <div
      data-cellar-control-row
      className="-mx-md mb-md bg-surface-sunken px-md py-sm md:-mx-lg md:px-lg"
    >
      {/* One row, and it does not scroll: a row that scrolls is the same "too
          many buttons" defect with the evidence hidden. The scope select is
          the only flexible child; everything else is `shrink-0`. */}
      <div className="flex items-center gap-xs">
        <CellarScopeSelect
          counters={counters}
          activeFilter={activeFilter}
          onSelect={onSelectFilter}
        />

        <div className="ml-auto flex shrink-0 items-center gap-xs">
          {openBottleCount > 0 && (
            <Link
              href="/cellar/open"
              className="hidden h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-pill border border-edge px-md text-ledger font-medium text-ink hover:bg-surface/60 focus-ring sm:inline-flex"
            >
              Open bottles {openBottleCount}
            </Link>
          )}

          {reconcileCount > 0 && (
            <button
              type="button"
              onClick={onReconcile}
              className="hidden min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-pill bg-primary px-md text-ledger font-medium text-seal-ink hover:bg-primary-hover focus-ring sm:inline-flex"
            >
              {reconcileLabel} →
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

          {showViewToggle && <ViewToggle view={view} onViewChange={onViewChange} />}

          <OverflowMenu
            label="More cellar actions"
            items={menuItems}
            // With no settings entry the menu holds only the phone-demoted
            // pair, which are pills from 640px up — so the trigger itself has
            // nothing to offer there and goes away with them.
            className={showSettings ? undefined : "sm:hidden"}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * One button, not a segmented pair: two 44px halves cost 88px of a 354px row
 * to say what one can. It is labelled for the view it switches TO, which is
 * also what `e2e/mobile-wine-detail.test.ts` reaches for on a phone ("Grid
 * view" must be a real, visible control at 390px — CELLAR-08).
 */
function ViewToggle({
  view,
  onViewChange,
}: {
  view: "list" | "grid";
  onViewChange: (view: "list" | "grid") => void;
}) {
  const next = view === "list" ? "grid" : "list";
  const Icon = next === "grid" ? LayoutGrid : ListIcon;
  return (
    <button
      type="button"
      onClick={() => onViewChange(next)}
      aria-label={next === "grid" ? "Grid view" : "List view"}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill border border-edge bg-surface text-ink-soft transition-colors hover:bg-wash focus-ring"
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
    </button>
  );
}
