"use client";

// The palette's portalled panel (P1 slice 2a — program plan D3/D4): cellar
// and catalogue as separate sections with cellar first, provenance badges,
// the single "My cellar" scope chip, recents chips under an empty field, and
// the honest empty states — a cellar-scope miss routes to the scanner, an
// all-scope miss points at the companion (its CTA wires up when the
// assistant entry point is consolidated in slice 2c).
//
// The active-row index is FLAT across both sections, in the exact order the
// unified endpoint ranked the rows — the sections are presentation, not a
// reordering, so ArrowDown walks the ranking.

import { createPortal } from "react-dom";
import { WineThumb } from "@/components/wine-thumb";
import { cn } from "@/lib/utils";
import { catalogueWineTitle, wineDisplayName } from "@/lib/wine-display-name";

/** The row shape GET /api/search returns (src/lib/unified-search/merge.ts). */
export type UnifiedResult = {
  kind: "cellar" | "catalogue";
  provenance: "cellar" | "lwin" | "xwines" | "lwin+xwines";
  deduped: boolean;
  provisional: boolean;
  score: number;
  name: string;
  producer: string | null;
  vintage: number | null;
  region: string | null;
  country: string | null;
  colour: string | null;
  imageUrl: string | null;
  isEightysixed: boolean | null;
  /** Availability is a tenant fact: null on catalogue rows and degraded reads. */
  quantity: number | null;
  bin: string | null;
  wineId: string | null;
  lwinId: string | null;
  xwinesWineId: number | null;
};

export type AddState = "pending" | "added" | "error";

const PROVENANCE_LABEL: Record<UnifiedResult["provenance"], string | null> = {
  cellar: null,
  lwin: "LWIN",
  xwines: "X-Wines",
  "lwin+xwines": "LWIN · X-Wines",
};

export function PaletteResultsPanel({
  anchor,
  listboxId,
  optionId,
  rows,
  pending,
  active,
  scope,
  addStates,
  recents,
  onPick,
  onAdd,
  onSeeAll,
  onToggleScope,
  onRunRecent,
  onScanInstead,
}: {
  anchor: { top: number; left: number; width: number };
  listboxId: string;
  optionId: string;
  rows: UnifiedResult[];
  pending: boolean;
  active: number;
  scope: "all" | "cellar";
  addStates: ReadonlyMap<string, AddState>;
  recents: string[];
  onPick: (row: UnifiedResult) => void;
  onAdd: (row: UnifiedResult) => void;
  onSeeAll: () => void;
  onToggleScope: () => void;
  onRunRecent: (term: string) => void;
  onScanInstead: () => void;
}) {
  if (typeof document === "undefined") return null;

  // Flat ranking order, sectioned for display: each entry keeps its index.
  const indexed = rows.map((row, index) => ({ row, index }));
  const cellarRows = indexed.filter((r) => r.row.kind === "cellar");
  const catalogueRows = indexed.filter((r) => r.row.kind === "catalogue");
  const hasQueryResults = rows.length > 0;

  return createPortal(
    <div
      data-global-search-panel="true"
      className="fixed z-[var(--z-overlay)] max-h-[60vh] overflow-y-auto rounded-card card-surface"
      style={{ top: anchor.top, left: anchor.left, width: anchor.width, minWidth: 280 }}
    >
      <div className="flex items-center gap-sm border-b border-rule px-md py-xs">
        <button
          type="button"
          aria-pressed={scope === "cellar"}
          onClick={onToggleScope}
          className={cn(
            "rounded-pill border border-edge px-sm py-[2px] text-ledger transition-colors focus-ring",
            scope === "cellar" ? "bg-accent/15 text-ink" : "text-grey hover:text-ink-soft",
          )}
        >
          My cellar
        </button>
        <span className="text-ledger font-light text-grey">
          {scope === "cellar" ? "Searching your cellar" : "Cellar + catalogue"}
        </span>
      </div>

      {recents.length > 0 ? (
        <div className="flex flex-wrap gap-xs px-md py-sm" aria-label="Recent searches">
          {recents.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => onRunRecent(term)}
              className="rounded-pill border border-edge px-sm py-[2px] text-ledger text-ink-soft transition-colors hover:bg-wash focus-ring"
            >
              {term}
            </button>
          ))}
        </div>
      ) : null}

      {pending && !hasQueryResults ? (
        <p className="px-md py-sm text-body-sm font-light text-grey" role="status">
          Searching…
        </p>
      ) : null}

      {!pending && !hasQueryResults && recents.length === 0 ? (
        scope === "cellar" ? (
          <div className="px-md py-sm">
            <p className="text-body-sm font-light text-grey">Nothing in your cellar matches that.</p>
            <button
              type="button"
              onClick={onScanInstead}
              className="mt-xs text-body-sm text-ink-soft underline-offset-2 hover:underline focus-ring"
            >
              Scan a label instead
            </button>
          </div>
        ) : (
          <p className="px-md py-sm text-body-sm font-light text-grey">
            Nothing matched in the cellar or the catalogue — the companion can help with
            open-ended questions.
          </p>
        )
      ) : null}

      {hasQueryResults ? (
        <ul id={listboxId} role="listbox" aria-label="Wine search results">
          {cellarRows.length > 0 ? (
            <li role="presentation" data-palette-section="cellar"
              className="px-md pt-sm text-ledger uppercase tracking-wide text-grey">
              In your cellar
            </li>
          ) : null}
          {cellarRows.map(({ row, index }) => (
            <ResultRow key={row.wineId} row={row} index={index} active={active}
              optionId={optionId} addStates={addStates} onPick={onPick} onAdd={onAdd} />
          ))}
          {catalogueRows.length > 0 ? (
            <li role="presentation" data-palette-section="catalogue"
              className={cn("px-md pt-sm text-ledger uppercase tracking-wide text-grey",
                cellarRows.length > 0 && "border-t border-rule mt-xs")}>
              Catalogue
            </li>
          ) : null}
          {catalogueRows.map(({ row, index }) => (
            <ResultRow key={row.lwinId ?? `xw-${row.xwinesWineId}`} row={row} index={index}
              active={active} optionId={optionId} addStates={addStates} onPick={onPick} onAdd={onAdd} />
          ))}
        </ul>
      ) : null}

      {hasQueryResults ? (
        <button
          type="button"
          onClick={onSeeAll}
          className="flex min-h-11 w-full items-center border-t border-rule px-md py-sm text-left text-body-sm text-ink-soft transition-colors hover:bg-wash focus-ring"
        >
          See all matches in the cellar
        </button>
      ) : null}
    </div>,
    document.body,
  );
}

function ResultRow({
  row,
  index,
  active,
  optionId,
  addStates,
  onPick,
  onAdd,
}: {
  row: UnifiedResult;
  index: number;
  active: number;
  optionId: string;
  addStates: ReadonlyMap<string, AddState>;
  onPick: (row: UnifiedResult) => void;
  onAdd: (row: UnifiedResult) => void;
}) {
  const badge = PROVENANCE_LABEL[row.provenance];
  const addState = row.lwinId !== null ? addStates.get(row.lwinId) : undefined;
  const canAdd = row.kind === "catalogue" && row.lwinId !== null;
  // Availability leads a cellar row (D4). quantity null means the inventory
  // read degraded — say nothing rather than invent a zero.
  const meta = [
    row.kind === "cellar" && row.quantity !== null ? `${row.quantity} btl` : null,
    row.kind === "cellar" ? row.bin : null,
    row.vintage !== null ? String(row.vintage) : null,
    row.region,
    row.country,
  ].filter(Boolean).join(" · ");

  return (
    <li id={`${optionId}-${index}`} role="option" aria-selected={index === active}>
      <div
        className={cn(
          "flex w-full items-center gap-sm px-md py-sm transition-colors",
          index === active && "bg-wash",
        )}
      >
        <button
          type="button"
          onClick={() => onPick(row)}
          className="flex min-w-0 flex-1 items-center gap-sm text-left hover:bg-wash focus-ring"
        >
          <WineThumb
            src={row.imageUrl}
            producer={row.producer ?? ""}
            name={row.name}
            colour={row.colour}
            size={32}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-control text-ink">
              {row.kind === "cellar" ? (
                <>
                  {row.producer ? `${row.producer} ` : ""}
                  {wineDisplayName(row.producer ?? "", row.name)}
                  {row.vintage !== null ? ` ${row.vintage}` : ""}
                </>
              ) : (
                catalogueWineTitle(row.producer, row.name)
              )}
            </span>
            <span className="block truncate text-ledger font-light text-grey">{meta}</span>
          </span>
        </button>
        {row.isEightysixed === true ? (
          <span className="shrink-0 rounded-pill bg-danger/15 px-sm py-[2px] text-ledger text-danger">
            86&apos;d
          </span>
        ) : null}
        {row.provisional ? (
          <span className="shrink-0 rounded-pill border border-edge px-sm py-[2px] text-ledger text-grey">
            unresolved
          </span>
        ) : null}
        {badge ? (
          <span className="shrink-0 rounded-pill border border-edge px-sm py-[2px] text-ledger text-grey">
            {badge}
          </span>
        ) : null}
        {canAdd ? (
          <button
            type="button"
            data-palette-add="true"
            disabled={addState === "pending" || addState === "added"}
            onClick={() => onAdd(row)}
            className="shrink-0 rounded-pill border border-edge px-sm py-[2px] text-ledger text-ink-soft transition-colors hover:bg-wash focus-ring disabled:opacity-70"
          >
            {addState === "added" ? "Added" : addState === "pending" ? "Adding…" : addState === "error" ? "Retry add" : "Add"}
          </button>
        ) : null}
      </div>
    </li>
  );
}
