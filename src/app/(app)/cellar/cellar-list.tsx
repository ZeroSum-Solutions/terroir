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
import {
  assignCellarWineSections,
  CellarBatchSectionError,
} from "@/lib/cellar/batch-section";
import { cn } from "@/lib/utils";
import { ML_PER_OZ } from "@/lib/units";
import { useToast } from "@/lib/toast";
import {
  formatStatusLabel,
  getDrinkWindowStatus,
  getMarkerPosition,
  getYearsUntilWindowClose,
  isClosingWindow,
  isHolding,
} from "@/lib/drink-window/status";
import type { CellarWineRow } from "./types";

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
  sections,
}: {
  rows: CellarWineRow[];
  query: string;
  filter: CellarFilter;
  lowStockThreshold?: number;
  onSelectWine: (row: CellarWineRow) => void;
  onResetFilters: () => void;
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

  const filtered = useMemo(() => {
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
  const selectableFiltered = useMemo(
    () => filtered.filter((row) => row.has_inventory_record),
    [filtered],
  );
  const selectableIds = useMemo(
    () => new Set(selectableFiltered.map((row) => row.wine_id)),
    [selectableFiltered],
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
      const selectedWineIds = Array.from(selectedIds);
      let assignedCount = 0;
      try {
        assignedCount = await assignCellarWineSections({
          wineIds: selectedWineIds,
          section: assignTarget,
        });
        toast.success(`${selectedWineIds.length} wine${selectedWineIds.length === 1 ? "" : "s"} assigned to ${assignTarget}`);
        setSelectMode(false);
        setSelectedIds(new Set());
        setAssignTarget(null);
        router.refresh();
      } catch (err) {
        assignedCount =
          err instanceof CellarBatchSectionError
            ? err.assignedCount
            : assignedCount;
        const detail =
          err instanceof Error ? err.message : "Batch assign failed";
        toast.error(
          assignedCount > 0
            ? `${assignedCount} assigned before the failure. ${detail}`
            : detail,
        );
        if (assignedCount > 0) {
          setSelectedIds(
            new Set(selectedWineIds.slice(assignedCount)),
          );
        }
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [assignTarget, selectedIds, router, toast],
  );

  const toggleSelect = useCallback((wineId: string) => {
    if (!selectableIds.has(wineId)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(wineId)) next.delete(wineId);
      else next.add(wineId);
      return next;
    });
  }, [selectableIds]);

  const selectAll = useCallback(() => {
    const allIds = new Set(selectableFiltered.map((r) => r.wine_id));
    setSelectedIds(allIds);
  }, [selectableFiltered]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-white px-md py-2xl text-center">
        <p className="font-serif text-[16px] text-ink">No wines in your cellar yet.</p>
        <p className="mt-xs text-[13px] text-ink-muted">
          Scan an invoice to start building your cellar.
        </p>
        <Link
          href="/scan"
          className="mt-md inline-flex h-[40px] items-center justify-center rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover"
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
      <div className="rounded-md border border-border bg-white px-md py-lg text-center">
        <p className="text-[13px] text-ink-muted">{message}</p>
        <button
          type="button"
          onClick={onResetFilters}
          className="mt-sm inline-flex h-[32px] items-center rounded-sm border border-border-strong bg-white px-md text-[12px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-accent-soft"
        >
          Clear filter & search
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* BND-064: Selection mode toolbar */}
      {sections && sections.length > 0 && (
        <div className="mb-sm flex items-center gap-xs">
          {!selectMode ? (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              className="inline-flex h-[32px] items-center gap-xs rounded-sm border border-border bg-white px-sm text-[12px] font-medium text-ink-muted hover:bg-surface-muted transition-colors"
            >
              <CheckSquare className="h-4 w-4" strokeWidth={2} aria-hidden />
              Select wines
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-xs w-full">
              <button
                type="button"
                onClick={selectAll}
                className="inline-flex h-[32px] items-center rounded-sm border border-border bg-white px-sm text-[12px] font-medium text-ink hover:bg-surface-muted"
              >
                Select all ({selectableFiltered.length})
              </button>
              {selectedIds.size > 0 && (
                <button
                  type="button"
                  onClick={deselectAll}
                  className="inline-flex h-[32px] items-center rounded-sm border border-border bg-white px-sm text-[12px] font-medium text-ink-muted hover:bg-surface-muted"
                >
                  Clear
                </button>
              )}
              {selectedIds.size > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setAssignTarget(assignTarget ? null : "__open__")}
                    className="inline-flex h-[32px] items-center gap-xs rounded-sm bg-accent px-sm text-[12px] font-medium text-white hover:bg-accent-hover"
                  >
                    <Layers className="h-4 w-4" strokeWidth={2} aria-hidden />
                    Assign {selectedIds.size} to section
                    <ChevronDown className="h-3 w-3" strokeWidth={2} aria-hidden />
                  </button>
                  {assignTarget === "__open__" && (
                    <div className="absolute top-full left-0 mt-1 z-20 w-56 rounded-sm border border-border bg-white shadow-lg py-xs">
                      {sections.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setAssignTarget(s.name)}
                          className="block w-full px-sm py-xs text-left text-[13px] text-ink hover:bg-surface-muted"
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
                  <span className="text-[12px] text-ink-muted">
                    Assign to <strong>{assignTarget}</strong>?
                  </span>
                  <button
                    type="button"
                    onClick={doBulkAssign}
                    disabled={busy}
                    className="inline-flex h-[32px] items-center rounded-sm bg-accent px-sm text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
                  >
                    {busy ? "..." : "Confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAssignTarget(null)}
                    disabled={busy}
                    className="inline-flex h-[32px] items-center rounded-sm border border-border bg-white px-sm text-[12px] font-medium text-ink-muted hover:bg-surface-muted disabled:opacity-60"
                  >
                    <X className="h-3 w-3" strokeWidth={2} aria-hidden />
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => { setSelectMode(false); setSelectedIds(new Set()); setAssignTarget(null); }}
                className="ml-auto inline-flex h-[32px] items-center rounded-sm border border-border bg-white px-sm text-[12px] font-medium text-ink-muted hover:bg-surface-muted"
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}

      {/* Wine list with optional DnD section grouping */}
      {sections && sections.length > 0 ? (
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
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-white">
          {filtered.map((row) => (
            <CellarRow
              key={row.wine_id}
              row={row}
              lowStockThreshold={lowStockThreshold}
              onSelect={() => onSelectWine(row)}
            />
          ))}
        </ul>
      )}
    </div>
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
    <div className="rounded-md border border-border bg-white overflow-hidden">
      {/* Section header — acts as drop target */}
      <div
        id={dropId}
        className="flex items-center gap-sm px-md py-sm bg-surface-muted border-b border-border"
      >
        <h3 className="text-[13px] font-semibold text-ink">{sectionName}</h3>
        <span className="inline-flex items-center rounded-full bg-accent-soft px-sm py-2xs text-[11px] font-medium text-accent">
          {wines.length}
        </span>
      </div>

      {/* Wine rows in this section */}
      {wines.length > 0 ? (
        <div className="divide-y divide-border">
          {wines.map((row) => (
            <DraggableWineRow
              key={row.wine_id}
              row={row}
              lowStockThreshold={lowStockThreshold}
              onSelect={() => onSelectWine(row)}
              selectMode={selectMode}
              selected={selectedIds.has(row.wine_id)}
              onToggleSelect={() => onToggleSelect(row.wine_id)}
            />
          ))}
        </div>
      ) : (
        <div className="px-md py-lg text-center text-[13px] text-ink-muted">
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
      className={cn(isDragging && "bg-surface-muted shadow-md rounded-sm")}
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

  let chip: { label: string; tone: "neutral" | "ok" | "warn" | "danger" | "muted" };
  if (row.is_eightysixed) {
    chip = { label: "86'd", tone: "danger" };
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
          disabled={!row.has_inventory_record}
          className="flex h-[44px] w-[44px] shrink-0 items-center justify-center text-ink-subtle hover:text-accent disabled:cursor-not-allowed disabled:opacity-30"
          aria-label={
            !row.has_inventory_record
              ? "Cannot assign a wine without an inventory record"
              : selected
                ? "Deselect"
                : "Select"
          }
          title={
            row.has_inventory_record
              ? undefined
              : "This wine has no inventory record to assign."
          }
        >
          {selected ? (
            <CheckSquare className="h-5 w-5 text-accent" strokeWidth={2} aria-hidden />
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
          className="flex h-[44px] w-[36px] shrink-0 items-center justify-center cursor-grab active:cursor-grabbing text-ink-subtle hover:text-ink-muted touch:min-h-[44px] touch:min-w-[44px]"
        >
          <GripVertical className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      )}

      <button
        type="button"
        onClick={selectMode ? undefined : onSelect}
        className="flex-1 min-w-0 px-md py-md text-left transition-colors hover:bg-surface-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-inset rounded-sm"
      >
        <div className="flex items-start justify-between gap-md">
          <div className="min-w-0 flex-1">
            {/* Producer · Vintage · Region */}
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
              <span className="text-ink-muted">{row.producer}</span>
              {row.vintage && <span className="ml-xs font-mono">{row.vintage}</span>}
              {row.region && <span className="ml-xs">· {row.region}</span>}
            </div>
            {/* Wine name */}
            <div className="mt-2xs font-serif text-[16px] text-ink">{row.name}</div>
            {/* Stock + drink-window + bin row */}
            <div className="mt-xs flex flex-wrap items-center gap-sm text-[12px] text-ink-muted">
              <Chip tone={chip.tone}>{chip.label}</Chip>
              {isLowStock && (
                <span className="inline-flex items-center rounded-full bg-warning-soft px-sm py-2xs text-[11px] font-medium text-warning">Low Stock</span>
              )}
              {isPeakWindow && (
                <span className="inline-flex items-center rounded-full bg-accent-soft px-sm py-2xs text-[11px] font-medium text-accent">Peak Window</span>
              )}
              {glassesLeft !== null && glassesLeft > 0 && !row.is_eightysixed && (
                <span className="text-ink-muted">
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
                <span className="inline-flex items-center gap-2xs font-mono text-ink-subtle">
                  <MapPin className="h-3 w-3" strokeWidth={2} aria-hidden />
                  {row.bin_location}
                </span>
              )}
            </div>
          </div>
          {!selectMode && (
            <span
              aria-hidden
              className="mt-2xs flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-ink-subtle"
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

  const tone: "warn" | "muted" | "ok" =
    status === "drink_now" || status === "past_peak"
      ? "warn"
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
            background: "var(--color-accent)",
          }}
        />
      </span>
      <Chip tone={tone}>{label}</Chip>
    </span>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: "neutral" | "ok" | "warn" | "danger" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-sm py-2xs text-[11px] font-medium",
        tone === "ok" && "bg-success-soft text-success",
        tone === "warn" && "bg-warning-soft text-warning",
        tone === "danger" && "bg-warning-soft text-warning",
        tone === "neutral" && "bg-accent-soft text-accent",
        tone === "muted" && "bg-surface-muted text-ink-subtle",
      )}
    >
      {children}
    </span>
  );
}
