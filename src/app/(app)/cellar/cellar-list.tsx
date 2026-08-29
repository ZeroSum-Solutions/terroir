"use client";

import { useMemo, useState, useCallback, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { GripVertical, CheckSquare, Square, Layers, ChevronDown, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { WineThumb } from "@/components/wine-thumb";
import { useToast } from "@/lib/toast";
import {
  applyFacets,
  facetCounts,
  groupRows,
  type CellarFacetGroup,
  type CellarFacets,
  type CellarGroupBy,
} from "@/lib/cellar-facets";
import { applyCellarQueryFilter } from "@/lib/cellar-facets/query-filter";
import { sortCellarRows, type CellarSort } from "@/lib/cellar-facets/sort";
import { StatusChip } from "@/components/status-chip";
import { bottlesOnHand, pickRowChip } from "./row-chip";
import type { CellarWineRow } from "./types";
import {
  CellarFacetBar,
  type CellarFacetPatch,
} from "./cellar-facet-bar";

/**
 * CellarList — the unified wine list inside Cellar's single-screen
 * consolidation (Phase 2 IA redesign — .council/specs/2026-04-24-ux-ia-redesign.md
 * §4 "Per-row behavior").
 *
 * BND-063/064 — section grouping, DnD between sections, and bulk-select
 * mode for assigning wines to cellar sections.
 */

export type CellarFilter =
  | "all"
  | "open"
  | "out"
  | "low"
  | "off-site"
  // BND-039 — drink-window filter chips
  | "drink-now"
  | "hold";

// Human-readable labels for filter chips
export const FILTER_LABELS: Record<Exclude<CellarFilter, "all">, string> = {
  open: "Open",
  out: "86'd",
  low: "Low stock",
  "off-site": "Off-site",
  "drink-now": "Drink now",
  hold: "Hold",
};

type CellarSection = { id: string; name: string };
const CELLAR_PAGE_SIZE = 50;

/**
 * Desktop ledger-table column template (Kimi audit D4 — a real workspace
 * ≥1024px instead of the mobile stack stretched to full width):
 * Wine | Vintage | Region | Status | Bin | Qty.
 */
const LEDGER_COLS =
  "lg:grid-cols-[minmax(0,1fr)_60px_minmax(110px,170px)_150px_100px_52px]";

export function CellarList({
  rows,
  query,
  filter,
  lowStockThreshold,
  onSelectWine,
  onResetFilters,
  facets,
  groupBy,
  sort,
  onFacetsChange,
  onGroupByChange,
  onFilteredCountChange,
  sections,
}: {
  rows: CellarWineRow[];
  query: string;
  filter: CellarFilter;
  lowStockThreshold?: number;
  onSelectWine: (row: CellarWineRow) => void;
  onResetFilters: () => void;
  facets: CellarFacets;
  groupBy: CellarGroupBy | null;
  sort: CellarSort | null;
  onFacetsChange: (patch: CellarFacetPatch) => void;
  onGroupByChange: (groupBy: CellarGroupBy | null) => void;
  // Reports the post-filter row count up to the shell's sticky masthead.
  onFilteredCountChange?: (count: number) => void;
  // BND-063/064 — cellar sections for grouping, DnD, and bulk assign
  sections?: CellarSection[];
}) {
  const router = useRouter();
  const toast = useToast();

  // BND-064: selection mode state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assignTarget, setAssignTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paginationKey = [
    query,
    filter,
    facets.producer,
    facets.region,
    facets.country,
    facets.varietal,
    facets.vintageMin,
    facets.vintageMax,
    facets.format,
    facets.health,
    groupBy,
    sort,
  ].join("\u0000");
  const [pagination, setPagination] = useState({
    key: paginationKey,
    count: CELLAR_PAGE_SIZE,
  });
  const visibleCount =
    pagination.key === paginationKey ? pagination.count : CELLAR_PAGE_SIZE;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  // Shared with the Gallery view so one link can never show two different
  // result sets (see lib/cellar-facets/query-filter).
  const filteredWithoutFacets = useMemo(
    () => applyCellarQueryFilter(rows, query, filter),
    [rows, query, filter],
  );

  const filtered = useMemo(
    () => sortCellarRows(applyFacets(filteredWithoutFacets, facets), sort),
    [filteredWithoutFacets, facets, sort],
  );
  useEffect(() => {
    onFilteredCountChange?.(filtered.length);
  }, [filtered.length, onFilteredCountChange]);
  const visibleRows = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const counts = useMemo(
    () => facetCounts(filteredWithoutFacets, facets),
    [filteredWithoutFacets, facets],
  );
  const taxonomyGroups = useMemo(
    () => (groupBy ? groupRows(visibleRows, groupBy) : []),
    [visibleRows, groupBy],
  );

  // BND-063: group filtered wines by section. "Uncategorized" for wines
  // without a section. If no sections are configured, all wines go into
  // a single uncategorized group.
  const sectionGroups = useMemo(() => {
    const groups: Map<string, { name: string; wines: CellarWineRow[] }> = new Map();
    const sectionMap = new Map((sections ?? []).map((s) => [s.name, s]));

    // Initialize groups in section order
    for (const s of sections ?? []) {
      groups.set(s.name, { name: s.name, wines: [] });
    }
    // Always have uncategorized at the end
    groups.set("__uncategorized__", { name: "Uncategorized", wines: [] });

    for (const wine of visibleRows) {
      const key = wine.section && sectionMap.has(wine.section) ? wine.section : "__uncategorized__";
      const group = groups.get(key);
      if (group) {
        group.wines.push(wine);
      } else {
        groups.get("__uncategorized__")!.wines.push(wine);
      }
    }

    // Remove empty groups (except uncategorized)
    const result: Array<{ key: string; name: string; wines: CellarWineRow[] }> = [];
    for (const [key, group] of groups) {
      if (group.wines.length > 0 || key === "__uncategorized__") {
        result.push({ key, name: group.name, wines: group.wines });
      }
    }
    return result;
  }, [visibleRows, sections]);

  // BND-063: handle DnD — when a wine is dropped into a different section
  /**
   * The dragged row renders through a portalled overlay rather than in place.
   * z-index cannot lift an element out of a clipping ancestor, and every
   * section card is `overflow-hidden` — so the old approach (opacity 0.5 plus
   * a local zIndex) left the row visibly sheared off at the section boundary
   * the moment it was picked up. Only a portal escapes that (DESIGN.md —
   * Layers).
   */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // The canonical "am I past hydration" read. document.body does not exist on
  // the server, and a setState-in-effect would do the same job while tripping
  // react-hooks/set-state-in-effect.
  const portalReady = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const draggingRow = useMemo(
    () => (draggingId ? (rows.find((r) => r.wine_id === draggingId) ?? null) : null),
    [draggingId, rows],
  );
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const wineId = String(active.id);
      const targetSection = String(over.id); // over.id is the section key

      if (targetSection.startsWith("wine-")) return; // dropped on another wine, not a section

      // Find current section for this wine
      const wine = rows.find((r) => r.wine_id === wineId);
      if (!wine) return;
      if (wine.section === targetSection.replace("section-", "")) return;

      // Optimistic update: update the wine's section locally
      wine.section = targetSection === "section-__uncategorized__" ? null : targetSection.replace("section-", "");

      // Persist via API
      try {
        const res = await fetch(`/api/cellar/${wineId}/section`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section: wine.section ?? sections?.find((s) => s.name === wine.section)?.name ?? "" }),
        });
        if (!res.ok) {
          throw new Error(`Failed (${res.status})`);
        }
        router.refresh();
      } catch {
        toast.error("Failed to move wine");
      }
    },
    [rows, sections, router, toast],
  );

  // BND-064: bulk assign selected wines to a section
  const doBulkAssign = useCallback(
    async () => {
      if (!assignTarget || selectedIds.size === 0) return;
      setBusy(true);
      try {
        const res = await fetch("/api/cellar/batch-section", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wine_ids: Array.from(selectedIds),
            section: assignTarget,
          }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(payload?.error?.message ?? `Failed (${res.status})`);
        }
        toast.success(`${selectedIds.size} wine${selectedIds.size === 1 ? "" : "s"} assigned to ${assignTarget}`);
        setSelectMode(false);
        setSelectedIds(new Set());
        setAssignTarget(null);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Batch assign failed");
      } finally {
        setBusy(false);
      }
    },
    [assignTarget, selectedIds, router, toast],
  );

  const toggleSelect = useCallback((wineId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(wineId)) next.delete(wineId);
      else next.add(wineId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    const allIds = new Set(filtered.map((r) => r.wine_id));
    setSelectedIds(allIds);
  }, [filtered]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  if (rows.length === 0) {
    return (
      <div className="rounded-card card-surface px-md py-2xl text-center">
        <p className="font-serif text-[17px] font-medium text-ink">No wines in your cellar yet.</p>
        <p className="mt-xs text-[13px] text-grey">
          Scan an invoice, photograph a bottle, or import a spreadsheet to start building your cellar.
        </p>
        <div className="mt-md flex flex-col items-center gap-sm">
          <Link
            href="/scan"
            className="inline-flex min-h-11 items-center justify-center rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover"
          >
            Scan an invoice →
          </Link>
          <div className="flex flex-wrap items-center justify-center gap-sm">
            <Link
              href="/scan?mode=bottle"
              className="inline-flex min-h-11 items-center justify-center rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-ring"
            >
              Scan a bottle
            </Link>
            <Link
              href="/import"
              className="inline-flex min-h-11 items-center justify-center rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-ring"
            >
              Import a CSV
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    const trimmedQuery = query.trim();
    const filterLabel = filter === "all" ? null : FILTER_LABELS[filter];
    let message: string;
    if (trimmedQuery && filterLabel) {
      message = `No wines match "${trimmedQuery}" in ${filterLabel}.`;
    } else if (trimmedQuery) {
      message = `No wines match "${trimmedQuery}".`;
    } else if (filterLabel) {
      message = `No wines match the ${filterLabel} filter.`;
    } else {
      message = "No wines match the current filter.";
    }
    return (
      <>
        <CellarFacetBar
          facets={facets}
          counts={counts}
          groupBy={groupBy}
          onFacetsChange={onFacetsChange}
          onGroupByChange={onGroupByChange}
        />
        <div className="rounded-card card-surface px-md py-lg text-center">
          <p className="text-[13px] text-grey">{message}</p>
          <button
            type="button"
            onClick={onResetFilters}
            className="mt-sm inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-md text-[12px] font-medium text-ink hover:bg-bridge-surface focus-ring"
          >
            Clear filters & search
          </button>
        </div>
      </>
    );
  }

  return (
    <div>
      <CellarFacetBar
        facets={facets}
        counts={counts}
        groupBy={groupBy}
        onFacetsChange={onFacetsChange}
        onGroupByChange={onGroupByChange}
      />
      {/* BND-064: Selection mode toolbar */}
      {sections && sections.length > 0 && !groupBy && (
        <div className="mb-sm flex items-center gap-xs">
          {!selectMode ? (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-edge bg-surface px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface transition-colors"
            >
              <CheckSquare className="h-4 w-4" strokeWidth={2} aria-hidden />
              Select wines
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-xs w-full">
              <button
                type="button"
                onClick={selectAll}
                className="inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface"
              >
                Select all ({filtered.length})
              </button>
              {selectedIds.size > 0 && (
                <button
                  type="button"
                  onClick={deselectAll}
                  className="inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface"
                >
                  Clear
                </button>
              )}
              {selectedIds.size > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setAssignTarget(assignTarget ? null : "__open__")}
                    className="inline-flex min-h-11 items-center gap-xs rounded-pill bg-primary px-sm text-[12px] font-medium text-white hover:bg-primary-hover"
                  >
                    <Layers className="h-4 w-4" strokeWidth={2} aria-hidden />
                    Assign {selectedIds.size} to section
                    <ChevronDown className="h-3 w-3" strokeWidth={2} aria-hidden />
                  </button>
                  {assignTarget === "__open__" && (
                    <div className="absolute top-full left-0 mt-1 z-[var(--z-overlay)] w-56 rounded-lg card-surface py-xs">
                      {sections.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setAssignTarget(s.name)}
                          className="block min-h-11 w-full px-sm py-xs text-left text-[13px] text-ink hover:bg-bridge-surface"
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {assignTarget && assignTarget !== "__open__" && (
                <div className="flex items-center gap-xs">
                  <span className="text-[12px] text-grey">
                    Assign to <strong>{assignTarget}</strong>?
                  </span>
                  <button
                    type="button"
                    onClick={doBulkAssign}
                    disabled={busy}
                    className="inline-flex min-h-11 items-center rounded-pill bg-primary px-sm text-[12px] font-medium text-white hover:bg-primary-hover disabled:opacity-60"
                  >
                    {busy ? "..." : "Confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAssignTarget(null)}
                    disabled={busy}
                    className="inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface disabled:opacity-60"
                  >
                    <X className="h-3 w-3" strokeWidth={2} aria-hidden />
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => { setSelectMode(false); setSelectedIds(new Set()); setAssignTarget(null); }}
                className="ml-auto inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface"
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}

      {/* Wine list with optional DnD section grouping */}
      {groupBy ? (
        <div className="flex flex-col gap-md">
          {taxonomyGroups.map((group) => (
            <TaxonomyGroup
              key={group.key}
              group={group}
              lowStockThreshold={lowStockThreshold}
              onSelectWine={onSelectWine}
              sortActive={sort != null}
            />
          ))}
        </div>
      ) : sections && sections.length > 0 ? (
        <DndContext
          id="cellar-section-dnd"
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={(event) => {
            setDraggingId(null);
            void handleDragEnd(event);
          }}
          onDragCancel={() => setDraggingId(null)}
        >
          <div className="flex flex-col gap-md">
            {sectionGroups.map((group) => (
              <SectionGroup
                key={group.key}
                sectionKey={group.key}
                sectionName={group.name}
                wines={group.wines}
                lowStockThreshold={lowStockThreshold}
                onSelectWine={onSelectWine}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                sortActive={sort != null}
              />
            ))}
          </div>
          {portalReady &&
            createPortal(
              <DragOverlay style={{ zIndex: "var(--z-drag)" }}>
                {draggingRow ? (
                  <div className="rounded-lg card-surface shadow-glass">
                    <CellarRow
                      row={draggingRow}
                      lowStockThreshold={lowStockThreshold}
                      onSelect={() => {}}
                      selectMode={false}
                      selected={false}
                      onToggleSelect={() => {}}
                    />
                  </div>
                ) : null}
              </DragOverlay>,
              document.body,
            )}
        </DndContext>
      ) : (
        <div className="flex flex-col divide-y divide-hairline overflow-hidden rounded-card card-surface">
          {/* Ledger-table header — desktop workspace only */}
          <div
            aria-hidden
            className={cn(
              "hidden items-center gap-md bg-bridge-surface px-md py-xs lg:grid",
              LEDGER_COLS,
            )}
          >
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-grey">Wine</span>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-grey">Vintage</span>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-grey">Region</span>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-grey">Status</span>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-grey">Bin</span>
            <span className="text-right text-[10px] font-medium uppercase tracking-[0.18em] text-grey">Qty</span>
          </div>
          <LineageBlockList
            wines={visibleRows}
            preserveOrder={sort != null}
            renderRow={(row) => (
              <CellarRow
                row={row}
                lowStockThreshold={lowStockThreshold}
                onSelect={() => onSelectWine(row)}
              />
            )}
          />
        </div>
      )}
      {visibleRows.length < filtered.length && (
        <div className="mt-md flex justify-center">
          <button
            type="button"
            onClick={() =>
              setPagination({
                key: paginationKey,
                count: visibleCount + CELLAR_PAGE_SIZE,
              })
            }
            className="inline-flex min-h-11 items-center justify-center rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-ring"
          >
            Show {Math.min(CELLAR_PAGE_SIZE, filtered.length - visibleRows.length)} more · {visibleRows.length} of {filtered.length}
          </button>
        </div>
      )}
    </div>
  );
}

function TaxonomyGroup({
  group,
  lowStockThreshold,
  onSelectWine,
  sortActive,
}: {
  group: CellarFacetGroup<CellarWineRow>;
  lowStockThreshold?: number;
  onSelectWine: (row: CellarWineRow) => void;
  sortActive?: boolean;
}) {
  return (
    <section
      data-cellar-taxonomy-group
      data-group-value={group.key}
      className="overflow-hidden rounded-card card-surface"
    >
      <header className="flex items-center justify-between gap-md border-b border-beige-deep bg-beige px-md py-sm">
        <h2 className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-soft">
          {group.label}
        </h2>
        <span
          data-group-rollup
          className="tabular shrink-0 text-[11px] text-ink-soft"
        >
          {group.wineCount} wine{group.wineCount === 1 ? "" : "s"} · {group.totalBottles}{" "}
          bottle{group.totalBottles === 1 ? "" : "s"}
        </span>
      </header>
      <div className="divide-y divide-hairline">
        <LineageBlockList
          wines={group.wines}
          preserveOrder={sortActive}
          renderRow={(row) => (
            <CellarRow
              row={row}
              lowStockThreshold={lowStockThreshold}
              onSelect={() => onSelectWine(row)}
            />
          )}
        />
      </div>
    </section>
  );
}

/**
 * OPP-1 (wave 0, EV-1.1) — lineage grouping. Wines sharing a lineage
 * (one producer-cuvée) render as a single expandable block: a header row
 * with the rollup (vintage span, total bottles) above per-vintage child
 * rows. Wines whose lineage has a single member — or none — render as
 * plain rows in their original position, so cellars without vintage
 * siblings look exactly as before.
 */
type LineageBlock =
  | { kind: "single"; row: CellarWineRow }
  | {
      kind: "lineage";
      lineageId: string;
      producer: string;
      name: string;
      totalBottles: number;
      span: [number, number] | null;
      rows: CellarWineRow[];
    };

function buildLineageBlocks(
  wines: CellarWineRow[],
  preserveOrder: boolean,
): LineageBlock[] {
  const counts = new Map<string, number>();
  for (const w of wines) {
    if (w.lineage_id) counts.set(w.lineage_id, (counts.get(w.lineage_id) ?? 0) + 1);
  }
  const emitted = new Set<string>();
  const blocks: LineageBlock[] = [];
  for (const w of wines) {
    const lid = w.lineage_id;
    if (!lid || (counts.get(lid) ?? 0) < 2) {
      blocks.push({ kind: "single", row: w });
      continue;
    }
    if (emitted.has(lid)) continue;
    emitted.add(lid);
    // With an explicit sort active, siblings keep the incoming (already
    // sorted) order — re-sorting newest-first here silently contradicted
    // the chosen sort inside expanded blocks (Sol audit, 2026-08-27).
    // Newest-first stays the default when no sort is chosen.
    const filtered = wines.filter((x) => x.lineage_id === lid);
    const members = preserveOrder
      ? filtered
      : filtered.sort((a, b) => (b.vintage ?? -1) - (a.vintage ?? -1));
    const vints = members
      .map((m) => m.vintage)
      .filter((v): v is number => v != null);
    blocks.push({
      kind: "lineage",
      lineageId: lid,
      producer: members[0].producer,
      name: members[0].name,
      totalBottles: members.reduce((acc, m) => acc + m.sealed_count, 0),
      span: vints.length ? [Math.min(...vints), Math.max(...vints)] : null,
      rows: members,
    });
  }
  return blocks;
}

function LineageBlockList({
  wines,
  renderRow,
  preserveOrder = false,
}: {
  wines: CellarWineRow[];
  renderRow: (row: CellarWineRow) => React.ReactNode;
  // True when a URL sort is active: lineage siblings then keep the
  // sorted order instead of the newest-first default.
  preserveOrder?: boolean;
}) {
  const blocks = useMemo(
    () => buildLineageBlocks(wines, preserveOrder),
    [wines, preserveOrder],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        blocks.flatMap((block) =>
          block.kind === "lineage" ? [block.lineageId] : [],
        ),
      ),
  );

  const toggle = useCallback((lineageId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(lineageId)) next.delete(lineageId);
      else next.add(lineageId);
      return next;
    });
  }, []);

  return (
    <>
      {blocks.map((block) =>
        block.kind === "single" ? (
          <div key={block.row.wine_id}>{renderRow(block.row)}</div>
        ) : (
          <div key={`lineage-${block.lineageId}`} data-lineage-id={block.lineageId}>
            <button
              type="button"
              data-lineage-header
              onClick={() => toggle(block.lineageId)}
              aria-expanded={!collapsed.has(block.lineageId)}
              className="flex w-full items-center gap-sm px-md py-sm text-left bg-beige hover:bg-beige-deep/60 transition-colors"
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-grey transition-transform",
                  collapsed.has(block.lineageId) && "-rotate-90",
                )}
                strokeWidth={2}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-soft">
                  {block.producer}
                </span>
                <span className="block truncate font-serif text-[17px] font-medium text-ink">
                  {block.name}
                </span>
              </span>
              <span
                data-lineage-rollup
                className="tabular inline-flex shrink-0 items-center rounded-pill bg-surface/70 px-sm py-2xs text-[11px] font-medium text-ink-soft"
              >
                {block.rows.length} wines
                {block.span ? ` · ${block.span[0]}–${block.span[1]}` : ""}
                {` · ${block.totalBottles} btls`}
              </span>
            </button>
            {!collapsed.has(block.lineageId) && (
              <div
                data-lineage-children
                className="ml-md border-l-2 border-beige-deep divide-y divide-hairline"
              >
                {block.rows.map((row) => (
                  <div key={row.wine_id}>{renderRow(row)}</div>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </>
  );
}

/**
 * BND-063 — SectionGroup. A droppable section with a header and wine list.
 * Each wine row inside is draggable (using the wine_id as the DnD id).
 */
function SectionGroup({
  sectionKey,
  sectionName,
  wines,
  lowStockThreshold,
  onSelectWine,
  selectMode,
  selectedIds,
  onToggleSelect,
  sortActive,
}: {
  sectionKey: string;
  sectionName: string;
  wines: CellarWineRow[];
  lowStockThreshold?: number;
  onSelectWine: (row: CellarWineRow) => void;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (wineId: string) => void;
  sortActive?: boolean;
}) {
  const dropId = `section-${sectionKey}`;

  return (
    <div className="rounded-card card-surface overflow-hidden">
      {/* Section header — acts as drop target */}
      <div
        id={dropId}
        className="flex items-center gap-sm px-md py-sm bg-beige border-b border-beige-deep"
      >
        <h3 className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-soft">
          {sectionName}
        </h3>
        <span className="tabular inline-flex items-center rounded-pill bg-surface/70 px-sm py-2xs text-[11px] font-medium text-ink-soft">
          {wines.length}
        </span>
      </div>

      {/* Wine rows in this section */}
      {wines.length > 0 ? (
        <div className="divide-y divide-hairline">
          <LineageBlockList
            wines={wines}
            preserveOrder={sortActive}
            renderRow={(row) => (
              <DraggableWineRow
                row={row}
                lowStockThreshold={lowStockThreshold}
                onSelect={() => onSelectWine(row)}
                selectMode={selectMode}
                selected={selectedIds.has(row.wine_id)}
                onToggleSelect={() => onToggleSelect(row.wine_id)}
              />
            )}
          />
        </div>
      ) : (
        <div className="px-md py-lg text-center text-[13px] text-grey">
          No wines in this section.
        </div>
      )}
    </div>
  );
}

/**
 * BND-063 — DraggableWineRow. A wine row wrapped in useSortable for DnD.
 */
function DraggableWineRow({
  row,
  lowStockThreshold,
  onSelect,
  selectMode,
  selected,
  onToggleSelect,
}: {
  row: CellarWineRow;
  lowStockThreshold?: number;
  onSelect: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.wine_id });

  // While dragging, the row keeps its space in the list but hands its
  // appearance to the portalled DragOverlay — a local z-index cannot escape
  // the section card's `overflow-hidden`.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "bg-wash rounded-lg")}
    >
      <CellarRow
        row={row}
        lowStockThreshold={lowStockThreshold}
        onSelect={onSelect}
        selectMode={selectMode}
        selected={selected}
        onToggleSelect={onToggleSelect}
        dragHandle={
          !selectMode
            ? { attributes: { ...attributes }, listeners: { ...listeners } }
            : undefined
        }
      />
    </div>
  );
}

function CellarRow({
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
  dragHandle?: {
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown>;
  };
}) {
  // One chip per row (Kimi audit 2026-08-26) — the most urgent fact wins;
  // stock lives in the quantity column, location in the bin column, and
  // the full drink-window instrument in the drawer.
  const chip = pickRowChip(row, lowStockThreshold);
  const onHand = bottlesOnHand(row);

  return (
    <div
      className="flex items-center"
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
            <CheckSquare className="h-5 w-5 text-accent" strokeWidth={2} aria-hidden />
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
        className="flex-1 min-w-0 px-md py-sm text-left transition-colors hover:bg-bridge-surface focus-ring rounded-md"
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
              {row.name}
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
                {row.name}
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
