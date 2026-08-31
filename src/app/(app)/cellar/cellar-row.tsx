import { GripVertical, CheckSquare, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { WineThumb } from "@/components/wine-thumb";
import { StatusChip } from "@/components/status-chip";
import { bottlesOnHand, pickRowChip } from "./row-chip";
import type { CellarWineRow } from "./types";
import { wineDisplayName } from "@/lib/wine-display-name";

/**
 * Desktop ledger-table column template (Kimi audit D4 — a real workspace
 * ≥1024px instead of the mobile stack stretched to full width):
 * Wine | Vintage | Region | Status | Bin | Qty.
 */
export const LEDGER_COLS =
  "lg:grid-cols-[minmax(0,1fr)_60px_minmax(110px,170px)_150px_100px_52px]";

/**
 * SD-40 — WHY BOTH TREES STAY IN THE DOM. Measured 2026-08-31, do not
 * re-derive.
 *
 * Every row renders its content twice: the `lg:hidden` phone stack below and
 * the `hidden … lg:grid` ledger row after it. Both are always in the DOM, so
 * a 50-row `/cellar` emits 100 `<img>` for 50 rows. That number is real and
 * confirmed against the live HTML. The COST it was assumed to carry is not:
 *
 *   - "50 unnecessary image requests on first paint" — REFUTED. Both copies
 *     of a row carry the BYTE-IDENTICAL src (WineThumb passes `unoptimized`,
 *     so no width lands in the URL, and the two only differ in CSS size).
 *     Measured: 100 <img>, 50 unique URLs. The browser fetches each once.
 *   - In production the cost is ZERO images. The demo seed tenant is the
 *     only place with a photograph on every wine; the production-shaped
 *     tenant renders **0 `<img>` for the same 50 rows**, because production
 *     wines have no hero_image_url — itself a downstream symptom of SD-41.
 *   - What the duplication actually costs: ~1.3 KB of markup per row,
 *     ~65 KB per 50-row page uncompressed, 5.5% of the page — but it is
 *     near-identical repeated text, so gzipped it is **3.3 KB, 3.8%**.
 *
 * Against that: eight test files reach into this row's structure, five of
 * them e2e (`taxonomy`, `lineage`, `cellar-health`, `pour-flow`,
 * `mobile-wine-detail`), and two of those carry comments explicitly built
 * around "CellarRow renders the name twice" and select by `data-cellar-row`
 * to work around it. Collapsing to one tree means a responsive rewrite of
 * both layouts plus that spec surface, to save 3.3 KB on the wire and no
 * image requests at all. The cure is worse than the disease. LEFT AS IS,
 * deliberately.
 */

/** Drag-handle wiring a draggable wrapper hands down to CellarRow. */
export type CellarRowDragHandle = {
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown>;
};

export function CellarRow({
  row,
  onSelect,
  lowStockThreshold,
  selectMode,
  selected,
  onToggleSelect,
  dragHandle,
}: {
  row: CellarWineRow;
  onSelect: () => void;
  lowStockThreshold?: number;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  dragHandle?: CellarRowDragHandle;
}) {
  // One chip per row (Kimi audit 2026-08-26) — the most urgent fact wins;
  // stock lives in the quantity column, location in the bin column, and
  // the full drink-window instrument in the drawer.
  const chip = pickRowChip(row, lowStockThreshold);
  const onHand = bottlesOnHand(row);

  return (
    <div
      className="flex items-center"
      data-cellar-row={row.wine_id}
      // OPP-1 (EV-1.2) — same lineage + vintage + format twin detected
      data-duplicate-suspect={row.duplicate_wine_ids.length > 0 ? "" : undefined}
    >
      {/* Selection checkbox */}
      {selectMode && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.(); }}
          className="flex h-[44px] w-[44px] shrink-0 items-center justify-center text-grey hover:text-accent"
          aria-label={selected ? "Deselect" : "Select"}
        >
          {selected ? (
            <CheckSquare className="h-5 w-5 text-mark" strokeWidth={2} aria-hidden />
          ) : (
            <Square className="h-5 w-5" strokeWidth={2} aria-hidden />
          )}
        </button>
      )}

      {/* Drag handle for DnD in non-select mode — desktop only: on
          phones it burned 44px of every ledger row (worsening name
          truncation) for a gesture Select-mode already covers. */}
      {dragHandle && (
        <button
          type="button"
          {...dragHandle.attributes}
          {...dragHandle.listeners}
          aria-label="Drag to reorder"
          className="hidden h-11 w-11 shrink-0 cursor-grab items-center justify-center text-grey hover:text-ink-soft active:cursor-grabbing md:flex"
        >
          <GripVertical className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      )}

      <button
        type="button"
        onClick={selectMode ? undefined : onSelect}
        className="flex-1 min-w-0 px-md py-sm text-left transition-colors hover:bg-wash focus-ring rounded-md"
      >
        {/* Mobile ledger row — two lines, location top-right, quantity in
            the Courier column (Kimi audit row anatomy: ~6–7 rows per
            viewport instead of 3). */}
        <div className="lg:hidden">
          <div className="flex items-baseline justify-between gap-sm">
            <div className="min-w-0 truncate text-caption font-medium uppercase text-grey">
              <span>{row.producer}</span>
              {row.vintage && <span className="tabular ml-xs">{row.vintage}</span>}
              {row.region && <span className="ml-xs">· {row.region}</span>}
            </div>
            {row.bin_location && (
              <span className="shrink-0 font-mono text-[11px] tracking-[0.04em] text-grey">
                {row.bin_location}
              </span>
            )}
          </div>
          <div className="mt-2xs flex items-center gap-sm">
            <WineThumb
              src={row.hero_image_url}
              producer={row.producer}
              name={row.name}
              colour={row.colour}
              size={36}
            />
            <span className="min-w-0 flex-1 truncate font-serif text-[17px] font-medium text-ink">
              {wineDisplayName(row.producer, row.name)}
            </span>
            {chip && (
              <StatusChip tone={chip.tone} className="shrink-0">
                {chip.label}
              </StatusChip>
            )}
            <span
              className={cn(
                "w-[38px] shrink-0 text-right font-mono text-[14px] tabular",
                onHand === 0 ? "text-grey" : "text-ink",
              )}
            >
              ×{onHand}
            </span>
          </div>
        </div>

        {/* Desktop ledger-table row (D4) */}
        <div className={cn("hidden items-center gap-md lg:grid", LEDGER_COLS)}>
          <div className="flex min-w-0 items-center gap-sm">
            <WineThumb
              src={row.hero_image_url}
              producer={row.producer}
              name={row.name}
              colour={row.colour}
              size={40}
            />
            <div className="min-w-0">
              <div className="truncate text-[10.5px] font-medium uppercase tracking-[0.14em] text-grey">
                {row.producer}
              </div>
              <div className="truncate font-serif text-[17px] font-medium text-ink">
                {wineDisplayName(row.producer, row.name)}
              </div>
            </div>
          </div>
          <span className="font-mono text-[13px] tabular text-ink-soft">
            {row.vintage ?? "—"}
          </span>
          <span className="truncate text-[12px] text-grey">{row.region ?? "—"}</span>
          <span>
            {chip ? (
              <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
            ) : (
              <span className="text-[12px] text-grey">—</span>
            )}
          </span>
          <span className="truncate font-mono text-[12px] text-grey">
            {row.bin_location ?? "—"}
          </span>
          <span
            className={cn(
              "text-right font-mono text-[14px] tabular",
              onHand === 0 ? "text-grey" : "text-ink",
            )}
          >
            ×{onHand}
          </span>
        </div>
      </button>
    </div>
  );
}
