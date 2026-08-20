"use client";

import { useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { MoreVertical, MapPin, GripVertical, CheckSquare, Square, Layers, ChevronDown, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { ML_PER_OZ } from "@/lib/units";
import { useToast } from "@/lib/toast";
import {
  applyFacets,
  facetCounts,
  groupRows,
  type CellarFacetGroup,
  type CellarFacets,
  type CellarGroupBy,
} from "@/lib/cellar-facets";
import {
  formatStatusLabel,
  getDrinkWindowStatus,
  getMarkerPosition,
  getYearsUntilWindowClose,
  isClosingWindow,
  isHolding,
} from "@/lib/drink-window/status";
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
const FILTER_LABELS: Record<Exclude<CellarFilter, "all">, string> = {
  open: "Open",
  out: "86'd",
  low: "Low stock",
  "off-site": "Off-site",
  "drink-now": "Drink now",
  hold: "Hold",
};

type CellarSection = { id: string; name: string };

export function CellarList({
  rows,
  query,
  filter,
  lowStockThreshold,
  onSelectWine,
  onResetFilters,
  facets,
  groupBy,
  onFacetsChange,
  onGroupByChange,
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
  onFacetsChange: (patch: CellarFacetPatch) => void;
  onGroupByChange: (groupBy: CellarGroupBy | null) => void;
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const filteredWithoutFacets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      switch (filter) {
        case "open":
          if (r.open_remaining_ml === null || r.open_remaining_ml <= 0) return false;
          break;
        case "out":
          if (!r.is_eightysixed) return false;
          break;
        case "low": {
          if (!r.size_ml) return false;
          const totalMl = (r.open_remaining_ml ?? 0) + r.sealed_count * r.size_ml;
          if (totalMl >= 2 * r.size_ml) return false;
          if (r.is_eightysixed) return false;
          break;
        }
        case "off-site":
          return false;
        case "drink-now":
          if (!isClosingWindow(r.drink_window_end)) return false;
          if (r.is_eightysixed) return false;
          break;
        case "hold":
          if (!isHolding(r.drink_window_start)) return false;
          if (r.is_eightysixed) return false;
          break;
        case "all":
        default:
          break;
      }
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.producer.toLowerCase().includes(q) ||
        (r.varietal ?? "").toLowerCase().includes(q) ||
        (r.region ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, filter]);

  const filtered = useMemo(
    () => applyFacets(filteredWithoutFacets, facets),
    [filteredWithoutFacets, facets],
  );
  const counts = useMemo(
    () => facetCounts(filteredWithoutFacets, facets),
    [filteredWithoutFacets, facets],
  );
  const taxonomyGroups = useMemo(
    () => (groupBy ? groupRows(filtered, groupBy) : []),
    [filtered, groupBy],
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

    for (const wine of filtered) {
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
  }, [filtered, sections]);

  // BND-063: handle DnD — when a wine is dropped into a different section
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
      <div className="rounded-card border border-hairline bg-white px-md py-2xl text-center">
        <p className="font-serif text-[17px] font-medium text-ink">No wines in your cellar yet.</p>
        <p className="mt-xs text-[13px] text-grey">
          Scan an invoice to start building your cellar.
        </p>
        <Link
          href="/scan"
          className="mt-md inline-flex h-[40px] items-center justify-center rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover"
        >
          Scan an invoice →
        </Link>
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
        <div className="rounded-card border border-hairline bg-white px-md py-lg text-center">
          <p className="text-[13px] text-grey">{message}</p>
          <button
            type="button"
            onClick={onResetFilters}
            className="mt-sm inline-flex h-[32px] items-center rounded-pill border border-ink/20 bg-white px-md text-[12px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-primary/25"
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
              className="inline-flex h-[32px] items-center gap-xs rounded-pill border border-ink/20 bg-white px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface transition-colors"
            >
              <CheckSquare className="h-4 w-4" strokeWidth={2} aria-hidden />
              Select wines
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-xs w-full">
              <button
                type="button"
                onClick={selectAll}
                className="inline-flex h-[32px] items-center rounded-pill border border-ink/20 bg-white px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface"
              >
                Select all ({filtered.length})
              </button>
              {selectedIds.size > 0 && (
                <button
                  type="button"
                  onClick={deselectAll}
                  className="inline-flex h-[32px] items-center rounded-pill border border-ink/20 bg-white px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface"
                >
                  Clear
                </button>
              )}
              {selectedIds.size > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setAssignTarget(assignTarget ? null : "__open__")}
                    className="inline-flex h-[32px] items-center gap-xs rounded-pill bg-primary px-sm text-[12px] font-medium text-white hover:bg-primary-hover"
                  >
                    <Layers className="h-4 w-4" strokeWidth={2} aria-hidden />
                    Assign {selectedIds.size} to section
                    <ChevronDown className="h-3 w-3" strokeWidth={2} aria-hidden />
                  </button>
                  {assignTarget === "__open__" && (
                    <div className="absolute top-full left-0 mt-1 z-20 w-56 rounded-lg border border-hairline bg-white py-xs">
                      {sections.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setAssignTarget(s.name)}
                          className="block w-full px-sm py-xs text-left text-[13px] text-ink hover:bg-bridge-surface"
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
                    className="inline-flex h-[32px] items-center rounded-pill bg-primary px-sm text-[12px] font-medium text-white hover:bg-primary-hover disabled:opacity-60"
                  >
                    {busy ? "..." : "Confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAssignTarget(null)}
                    disabled={busy}
                    className="inline-flex h-[32px] items-center rounded-pill border border-ink/20 bg-white px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface disabled:opacity-60"
                  >
                    <X className="h-3 w-3" strokeWidth={2} aria-hidden />
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => { setSelectMode(false); setSelectedIds(new Set()); setAssignTarget(null); }}
                className="ml-auto inline-flex h-[32px] items-center rounded-pill border border-ink/20 bg-white px-sm text-[12px] font-medium text-grey hover:bg-bridge-surface"
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
            />
          ))}
        </div>
      ) : sections && sections.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
              />
            ))}
          </div>
        </DndContext>
      ) : (
        <div className="flex flex-col divide-y divide-hairline rounded-card border border-hairline bg-white">
          <LineageBlockList
            wines={filtered}
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
    </div>
  );
}

function TaxonomyGroup({
  group,
  lowStockThreshold,
  onSelectWine,
}: {
  group: CellarFacetGroup<CellarWineRow>;
  lowStockThreshold?: number;
  onSelectWine: (row: CellarWineRow) => void;
}) {
  return (
    <section
      data-cellar-taxonomy-group
      data-group-value={group.key}
      className="overflow-hidden rounded-card border border-hairline bg-white"
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

function buildLineageBlocks(wines: CellarWineRow[]): LineageBlock[] {
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
    const members = wines
      .filter((x) => x.lineage_id === lid)
      .sort((a, b) => (b.vintage ?? -1) - (a.vintage ?? -1));
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
}: {
  wines: CellarWineRow[];
  renderRow: (row: CellarWineRow) => React.ReactNode;
}) {
  const blocks = useMemo(() => buildLineageBlocks(wines), [wines]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
                className="tabular inline-flex shrink-0 items-center rounded-pill bg-white/70 px-sm py-2xs text-[11px] font-medium text-ink-soft"
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
}: {
  sectionKey: string;
  sectionName: string;
  wines: CellarWineRow[];
  lowStockThreshold?: number;
  onSelectWine: (row: CellarWineRow) => void;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (wineId: string) => void;
}) {
  const dropId = `section-${sectionKey}`;

  return (
    <div className="rounded-card border border-hairline bg-white overflow-hidden">
      {/* Section header — acts as drop target */}
      <div
        id={dropId}
        className="flex items-center gap-sm px-md py-sm bg-beige border-b border-beige-deep"
      >
        <h3 className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-soft">
          {sectionName}
        </h3>
        <span className="tabular inline-flex items-center rounded-pill bg-white/70 px-sm py-2xs text-[11px] font-medium text-ink-soft">
          {wines.length}
        </span>
      </div>

      {/* Wine rows in this section */}
      {wines.length > 0 ? (
        <div className="divide-y divide-hairline">
          <LineageBlockList
            wines={wines}
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

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    position: "relative",
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "bg-bridge-surface rounded-lg")}
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
  const totalMl =
    row.size_ml === null
      ? null
      : (row.open_remaining_ml ?? 0) + row.sealed_count * row.size_ml;
  const glassesLeft =
    row.glass_pour_ml && totalMl !== null
      ? Math.floor(totalMl / row.glass_pour_ml)
      : null;
  const ozLeft =
    row.open_remaining_ml !== null
      ? (row.open_remaining_ml / ML_PER_OZ).toFixed(1)
      : null;
  const isLowStock = lowStockThreshold != null && row.sealed_count > 0 && row.sealed_count < lowStockThreshold && !row.is_eightysixed;
  const isPeakWindow = row.peak_year != null && row.peak_year === new Date().getFullYear() && !row.is_eightysixed;

  let chip: { label: string; tone: "neutral" | "ok" | "risk" | "muted" };
  if (row.is_eightysixed) {
    chip = { label: "86'd", tone: "risk" };
  } else if (row.open_remaining_ml !== null && row.open_remaining_ml > 0) {
    chip = {
      label: `Open · ${ozLeft} oz`,
      tone: "ok",
    };
  } else if (row.sealed_count > 0) {
    chip = {
      label: `${row.sealed_count} sealed`,
      tone: "neutral",
    };
  } else {
    chip = { label: "No stock", tone: "muted" };
  }

  return (
    <div className="flex items-center">
      {/* Selection checkbox */}
      {selectMode && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.(); }}
          className="flex h-[44px] w-[44px] shrink-0 items-center justify-center text-grey hover:text-primary"
          aria-label={selected ? "Deselect" : "Select"}
        >
          {selected ? (
            <CheckSquare className="h-5 w-5 text-primary" strokeWidth={2} aria-hidden />
          ) : (
            <Square className="h-5 w-5" strokeWidth={2} aria-hidden />
          )}
        </button>
      )}

      {/* Drag handle for DnD in non-select mode */}
      {dragHandle && (
        <button
          type="button"
          {...dragHandle.attributes}
          {...dragHandle.listeners}
          aria-label="Drag to reorder"
          className="flex h-[44px] w-[36px] shrink-0 items-center justify-center cursor-grab active:cursor-grabbing text-grey hover:text-ink-soft touch:min-h-[44px] touch:min-w-[44px]"
        >
          <GripVertical className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      )}

      <button
        type="button"
        onClick={selectMode ? undefined : onSelect}
        className="flex-1 min-w-0 px-md py-md text-left transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:ring-inset rounded-md"
      >
        <div className="flex items-start justify-between gap-md">
          <div className="min-w-0 flex-1">
            {/* Producer · Vintage · Region */}
            <div className="text-caption font-medium uppercase text-grey">
              <span>{row.producer}</span>
              {row.vintage && <span className="tabular ml-xs">{row.vintage}</span>}
              {row.region && <span className="ml-xs">· {row.region}</span>}
            </div>
            {/* Wine name */}
            <div className="mt-2xs font-serif text-[17px] font-medium text-ink">{row.name}</div>
            {/* Stock + drink-window + bin row */}
            <div className="mt-xs flex flex-wrap items-center gap-sm text-[12px] font-light text-grey">
              <Chip tone={chip.tone}>{chip.label}</Chip>
              {isLowStock && <Chip tone="risk">Low stock</Chip>}
              {isPeakWindow && <Chip tone="ok">Peak window</Chip>}
              {/* OPP-1 (EV-1.2) — same lineage + vintage + format twin detected */}
              {row.duplicate_wine_ids.length > 0 && (
                <span data-duplicate-suspect>
                  <Chip tone="warn">Possible duplicate</Chip>
                </span>
              )}
              {glassesLeft !== null && glassesLeft > 0 && !row.is_eightysixed && (
                <span className="tabular text-grey">
                  ~{glassesLeft} glass{glassesLeft === 1 ? "" : "es"} left
                </span>
              )}
              {!row.is_eightysixed && (
                <DrinkWindowIndicator
                  start={row.drink_window_start}
                  end={row.drink_window_end}
                />
              )}
              {row.bin_location && (
                <span className="tabular inline-flex items-center gap-2xs rounded-pill bg-beige px-sm py-[2px] text-[11px] text-ink-soft">
                  <MapPin className="h-3 w-3" strokeWidth={2} aria-hidden />
                  {row.bin_location}
                </span>
              )}
            </div>
          </div>
          {!selectMode && (
            <span
              aria-hidden
              className="mt-2xs flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-grey"
            >
              <MoreVertical className="h-4 w-4" strokeWidth={2} />
            </span>
          )}
        </div>
      </button>
    </div>
  );
}

function DrinkWindowIndicator({
  start,
  end,
}: {
  start: number | null;
  end: number | null;
}) {
  if (start == null || end == null) return null;
  const status = getDrinkWindowStatus(start, end);
  const yearsLeft = getYearsUntilWindowClose(end);
  const markerPct = getMarkerPosition(start, end);
  const label = formatStatusLabel(status, yearsLeft);

  const tone: "info" | "muted" | "ok" =
    status === "drink_now" || status === "past_peak"
      ? "info"
      : status === "hold"
        ? "muted"
        : status === "optimal"
          ? "ok"
          : "muted";

  return (
    <span className="inline-flex items-center gap-xs">
      <span
        aria-hidden
        className="relative inline-block h-[4px] w-[56px] rounded-full"
        style={{
          background:
            "linear-gradient(90deg, #E3EFE8 0%, #FBF3DC 60%, #F2D896 88%, #E8DCD0 100%)",
        }}
      >
        <span
          className="absolute h-[8px] w-[2px]"
          style={{
            top: "-2px",
            left: `${markerPct}%`,
            background: "var(--color-primary)",
          }}
        />
      </span>
      <Chip tone={tone}>{label}</Chip>
    </span>
  );
}

/**
 * Ledger Panel badge — DESIGN.md mapping: sage = healthy/in-window/ok,
 * powder = informational (window closing/drink now), blush+primary = risk,
 * amber = other warnings, neutral = routine stock count (no status signal).
 */
function Chip({
  tone,
  children,
}: {
  tone: "neutral" | "ok" | "info" | "risk" | "warn" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide",
        tone === "ok" && "bg-sage-wash text-sage-ink",
        tone === "info" && "bg-powder-wash text-powder-ink",
        tone === "risk" && "bg-blush-wash text-primary",
        tone === "warn" && "bg-amber-wash text-amber",
        tone === "neutral" && "bg-beige text-ink-soft",
        tone === "muted" && "bg-bridge-surface text-grey",
      )}
    >
      {children}
    </span>
  );
}
