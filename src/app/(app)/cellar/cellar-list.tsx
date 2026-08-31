"use client";

import { useMemo, useState, useCallback, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
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
import { cn } from "@/lib/utils";
import { useToast } from "@/lib/toast";
import {
  applyFacets,
  facetCounts,
  groupRows,
  type CellarFacets,
  type CellarGroupBy,
} from "@/lib/cellar-facets";
import { applyCellarQueryFilter } from "@/lib/cellar-facets/query-filter";
import { sortCellarRows, type CellarSort } from "@/lib/cellar-facets/sort";
import type { CellarWineRow } from "./types";
import {
  CellarFacetBar,
  type CellarFacetPatch,
} from "./cellar-facet-bar";
import { CellarRow, LEDGER_COLS } from "./cellar-row";
import { CellarSelectToolbar } from "./cellar-select-toolbar";
import { LineageBlockList } from "./lineage-block-list";
import { SectionGroup } from "./section-group";
import { TaxonomyGroup } from "./taxonomy-group";

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
/** The bucket for wines with no section, and the key its droppable carries. */
const UNCATEGORIZED = "__uncategorized__";

const CELLAR_PAGE_SIZE = 50;

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
  onSortChange,
  onFilteredCountChange,
  filtersOpen,
  onFiltersOpenChange,
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
  onSortChange: (sort: CellarSort | null) => void;
  // Reports the post-filter row count up to the shell's sticky masthead.
  onFilteredCountChange?: (count: number) => void;
  // CELLAR-01 — the button that opens the one filter surface lives in the
  // shell's single control row; the sheet itself renders here, where the
  // facet counts are.
  filtersOpen: boolean;
  onFiltersOpenChange: (open: boolean) => void;
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

  // A dropped row moves immediately through this override map rather than by
  // mutating the `rows` prop, so a failed PATCH can put it back.
  const [sectionOverrides, setSectionOverrides] = useState<Record<string, string | null>>({});

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
    groups.set(UNCATEGORIZED, { name: "Uncategorized", wines: [] });

    for (const wine of visibleRows) {
      // A drop moves the row immediately, but through an override map rather
      // than by mutating the `rows` prop — a failed PATCH has to be able to
      // put the wine back where it came from.
      const section = wine.wine_id in sectionOverrides ? sectionOverrides[wine.wine_id] : wine.section;
      const key = section && sectionMap.has(section) ? section : UNCATEGORIZED;
      const group = groups.get(key);
      if (group) {
        group.wines.push(wine);
      } else {
        groups.get(UNCATEGORIZED)!.wines.push(wine);
      }
    }

    // Every configured section renders, empty or not. Hiding the empty ones
    // meant a newly-created section was not a drop target until something was
    // already in it — you could never drag the first wine into it (CELLAR-04).
    return [...groups].map(([key, group]) => ({
      key,
      name: group.name,
      wines: group.wines,
    }));
  }, [visibleRows, sections, sectionOverrides]);

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

      // The target is read from the droppable's own `data`, never parsed out
      // of `over.id`. Sections used to carry only an HTML `id` and were never
      // registered with dnd-kit at all, so `over.id` was always another row's
      // UUID — which failed the old `startsWith("wine-")` guard and got
      // written to the database as the section NAME. Dropping onto a row now
      // resolves to that row's section, which is also what a user expects.
      const target = over.data.current as
        | { type: "section" | "wine"; sectionKey: string }
        | undefined;
      if (!target) return;
      const targetKey = target.sectionKey;

      const wineId = String(active.id);
      const wine = rows.find((r) => r.wine_id === wineId);
      if (!wine) return;

      const nextSection = targetKey === UNCATEGORIZED ? null : targetKey;
      const currentSection =
        wineId in sectionOverrides ? sectionOverrides[wineId] : wine.section;
      if (currentSection === nextSection) return;

      setSectionOverrides((prev) => ({ ...prev, [wineId]: nextSection }));

      try {
        const res = await fetch(`/api/cellar/${wineId}/section`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // null clears the section — the Uncategorized drop target. The
          // route accepts null explicitly; it used to 400 on the empty
          // string this sent instead (CELLAR-04).
          body: JSON.stringify({ section: nextSection }),
        });
        if (!res.ok) {
          throw new Error(`Failed (${res.status})`);
        }
        router.refresh();
      } catch {
        // Put it back. An optimistic move that silently sticks after a failed
        // write is a lie about where the bottle is.
        setSectionOverrides((prev) => ({ ...prev, [wineId]: currentSection }));
        toast.error("Failed to move wine");
      }
    },
    [rows, sectionOverrides, router, toast],
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
            className="inline-flex min-h-11 items-center justify-center rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover"
          >
            Scan an invoice →
          </Link>
          <div className="flex flex-wrap items-center justify-center gap-sm">
            <Link
              href="/scan?mode=bottle"
              className="inline-flex min-h-11 items-center justify-center rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring"
            >
              Scan a bottle
            </Link>
            <Link
              href="/import"
              className="inline-flex min-h-11 items-center justify-center rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring"
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
          sort={sort}
          open={filtersOpen}
          onOpenChange={onFiltersOpenChange}
          onFacetsChange={onFacetsChange}
          onGroupByChange={onGroupByChange}
          onSortChange={onSortChange}
        />
        <div className="rounded-card card-surface px-md py-lg text-center">
          <p className="text-[13px] text-grey">{message}</p>
          <button
            type="button"
            onClick={onResetFilters}
            className="mt-sm inline-flex min-h-11 items-center rounded-pill border border-edge bg-surface px-md text-[12px] font-medium text-ink hover:bg-wash focus-ring"
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
        sort={sort}
        open={filtersOpen}
        onOpenChange={onFiltersOpenChange}
        onFacetsChange={onFacetsChange}
        onGroupByChange={onGroupByChange}
        onSortChange={onSortChange}
        onEnterSelectMode={
          sections && sections.length > 0 && !groupBy
            ? () => setSelectMode(true)
            : undefined
        }
      />
      {/* BND-064 — bulk assign. Select-wines mode is entered from the filter
          surface now, so this is only ever on screen while the mode is on. */}
      {selectMode && sections && sections.length > 0 && !groupBy && (
        <CellarSelectToolbar
          sections={sections}
          totalCount={filtered.length}
          selectedCount={selectedIds.size}
          assignTarget={assignTarget}
          busy={busy}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onAssignTargetChange={setAssignTarget}
          onConfirm={doBulkAssign}
          onExit={() => {
            setSelectMode(false);
            setSelectedIds(new Set());
            setAssignTarget(null);
          }}
        />
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
        <div className="flex flex-col divide-y divide-rule overflow-hidden rounded-card card-surface">
          {/* Ledger-table header — desktop workspace only */}
          <div
            aria-hidden
            className={cn(
              "hidden items-center gap-md bg-wash px-md py-xs lg:grid",
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
            className="inline-flex min-h-11 items-center justify-center rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring"
          >
            Show {Math.min(CELLAR_PAGE_SIZE, filtered.length - visibleRows.length)} more · {visibleRows.length} of {filtered.length}
          </button>
        </div>
      )}
    </div>
  );
}
