"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Search, Settings, LayoutGrid, List as ListIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isHolding } from "@/lib/drink-window/status";
import {
  CELLAR_COLOURS,
  isCellarLowStock,
  isPastDrinkWindow,
  type CellarColour,
  type CellarInventoryViewOptions,
  type CellarSort,
} from "@/lib/cellar/inventory-view";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import type { CellarWineRow } from "./types";
import { CellarList, type CellarFilter } from "./cellar-list";
import { WineDetailDrawer } from "./wine-detail-drawer";
import { ReconcileModal } from "./reconcile-modal";
import { AutoEightysixModal } from "./auto-eightysix-modal";
import { CellarGridView, CellarSetup } from "./cellar-grid";
import { resolveCellarNavigationIntent } from "./cellar-navigation";

type CellarSection = { id: string; name: string };

/**
 * CellarShell — top-level client orchestrator for the consolidated
 * Cellar surface (Phase 2 IA redesign — .council/specs/2026-04-24-ux-ia-redesign.md).
 */
export function CellarShell({
  rows,
  reconcileItems,
  cellarConfig,
  gridData,
  gridTruncated,
  restaurantName,
  restaurantId,
  autoEightysixEnabled,
  autoEightysixThresholdMl,
  eightysixStrategy,
  defaultTargetPourCostPct,
  defaultTargetMarkupRatio,
  role,
  cellarSections,
}: {
  rows: CellarWineRow[];
  reconcileItems: OpenBottleRow[];
  cellarConfig: { id: string; rows: number; columns: number; name: string; lowStockThreshold: number; reconcileVarianceThresholdOz: number } | null;
  gridData: Record<
    string,
    {
      wines: Array<{
        wineId: string;
        name: string;
        producer: string;
        vintage: number | null;
        quantity: number;
      }>;
      totalBottles: number;
    }
  >;
  gridTruncated: boolean;
  restaurantName: string;
  restaurantId: string;
  autoEightysixEnabled: boolean;
  autoEightysixThresholdMl: number;
  eightysixStrategy: "hide" | "mark";
  defaultTargetPourCostPct: number | null;
  defaultTargetMarkupRatio: number | null;
  role: "owner" | "manager" | "staff";
  // BND-063/064 — cellar sections for grouping and DnD
  cellarSections?: CellarSection[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const mode = searchParams.get("mode");
  const wineId = searchParams.get("wine");

  const [initialMode] = useState(() => mode ?? "");
  const [initialWineId] = useState(() => wineId ?? "");

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(id);
  }, [query]);

  const [filter, setFilter] = useState<CellarFilter>(
    initialMode === "pour" ? "open" : "all",
  );
  const [colour, setColour] = useState<CellarColour | "all">("all");
  const [location, setLocation] = useState("");
  const [vintageMin, setVintageMin] = useState("");
  const [vintageMax, setVintageMax] = useState("");
  const [sort, setSort] = useState<CellarSort>("name");
  const [view, setView] = useState<"list" | "grid">("list");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialWineId && rows.some((r) => r.wine_id === initialWineId)
      ? initialWineId
      : null,
  );
  const selected = useMemo(
    () => (selectedId ? rows.find((r) => r.wine_id === selectedId) ?? null : null),
    [rows, selectedId],
  );
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(
    initialMode === "pour" || initialMode === "eightysix",
  );

  const canManage = role === "owner" || role === "manager";
  const isOwner = role === "owner";
  const locationOptions = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .flatMap((row) => [row.region, row.country])
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [rows],
  );
  const inventoryViewOptions = useMemo<CellarInventoryViewOptions>(
    () => ({
      colour,
      location,
      vintageMin: vintageMin === "" ? null : Number(vintageMin),
      vintageMax: vintageMax === "" ? null : Number(vintageMax),
      sort,
    }),
    [colour, location, vintageMin, vintageMax, sort],
  );

  useEffect(() => {
    const intent = resolveCellarNavigationIntent(
      mode,
      wineId,
      new Set(rows.map((row) => row.wine_id)),
    );
    if (!intent.shouldConsumeParams) return;

    const params = new URLSearchParams(searchParams.toString());
    params.delete("mode");
    params.delete("wine");
    const next = params.toString();
    const frame = requestAnimationFrame(() => {
      if (intent.filter) setFilter(intent.filter);
      if (intent.selectedWineId) setSelectedId(intent.selectedWineId);
      if (intent.shouldFocusSearch) setSearchOpen(true);
      router.replace(next ? `/cellar?${next}` : "/cellar", { scroll: false });
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [mode, wineId, rows, router, searchParams]);

  useEffect(() => {
    function handleSlash(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      e.preventDefault();
      const input = searchInputRef.current;
      if (input) {
        input.focus();
        input.select();
      } else {
        setSearchOpen(true);
      }
    }
    document.addEventListener("keydown", handleSlash);
    return () => document.removeEventListener("keydown", handleSlash);
  }, []);

  const alerts = useMemo(() => {
    const openCount = rows.filter(
      (r) => r.open_remaining_ml !== null && r.open_remaining_ml > 0,
    ).length;
    const outCount = rows.filter((r) => r.is_eightysixed).length;
    const lowCount = rows.filter((r) => {
      return isCellarLowStock(r, cellarConfig?.lowStockThreshold ?? 3);
    }).length;

    const drinkNowCount = rows.filter(
      (r) => isPastDrinkWindow(r),
    ).length;
    const holdCount = rows.filter(
      (r) => !r.is_eightysixed && isHolding(r.drink_window_start),
    ).length;

    return { openCount, outCount, lowCount, drinkNowCount, holdCount };
  }, [rows, cellarConfig?.lowStockThreshold]);

  const FILTER_CHIPS: Array<{ id: CellarFilter; label: string; count?: number }> = [
    { id: "all", label: "All" },
    { id: "open", label: "Open", count: alerts.openCount },
    { id: "out", label: "86'd", count: alerts.outCount },
    { id: "low", label: "Low stock", count: alerts.lowCount },
    ...(alerts.drinkNowCount > 0
      ? [{ id: "drink-now" as const, label: "Drink now", count: alerts.drinkNowCount }]
      : []),
    ...(alerts.holdCount > 0
      ? [{ id: "hold" as const, label: "Hold", count: alerts.holdCount }]
      : []),
  ];

  return (
    <section>
      {/* Header */}
      <header className="mb-md flex items-center gap-sm md:mb-lg">
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[24px] text-ink md:text-[28px]">Cellar</h1>
          <p className="mt-2xs text-[12px] text-ink-muted md:text-[13px]">
            {restaurantName}
            {cellarConfig && (
              <>
                {" "}
                · {cellarConfig.rows} × {cellarConfig.columns} grid
              </>
            )}
          </p>
        </div>

        <div className="hidden md:block">
          <SearchInput
            value={query}
            onChange={setQuery}
            inputRef={searchInputRef}
          />
        </div>

        <div className="flex items-center gap-2xs">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search wines"
            className="flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft md:hidden"
          >
            <Search className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>

          {cellarConfig && (
            <div className="hidden items-center rounded-sm border border-border md:inline-flex">
              <ViewToggleButton
                active={view === "list"}
                onClick={() => setView("list")}
                label="List"
                Icon={ListIcon}
              />
              <ViewToggleButton
                active={view === "grid"}
                onClick={() => setView("grid")}
                label="Grid"
                Icon={LayoutGrid}
              />
            </div>
          )}

          {isOwner && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Cellar settings"
              className="flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            >
              <Settings className="h-5 w-5" strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>
      </header>

      {/* Alerts banner */}
      {alerts.lowCount > 0 && view === "list" && (
        <div
          role="status"
          className="mb-md flex items-center justify-between gap-md rounded-sm border border-warning/30 bg-warning-soft px-md py-sm text-[13px] text-warning"
        >
          <span>
            {alerts.lowCount} wine{alerts.lowCount === 1 ? "" : "s"} low on stock
          </span>
          <button
            type="button"
            onClick={() => setFilter("low")}
            className="font-medium underline-offset-2 hover:underline"
          >
            Show
          </button>
        </div>
      )}

      {/* Filter chips */}
      {view === "list" && (
        <div
          className="mb-md flex gap-2xs overflow-x-auto pb-2xs md:flex-wrap"
          role="tablist"
          aria-label="Filter wines"
        >
          {FILTER_CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={filter === c.id}
              onClick={() => setFilter(c.id)}
              className={cn(
                "inline-flex h-[32px] shrink-0 items-center gap-xs rounded-full border px-md text-[12px] font-medium transition-colors",
                filter === c.id
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-white text-ink-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
              )}
            >
              {c.label}
              {c.count !== undefined && (
                <span
                  className={cn(
                    "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-xs font-mono text-[10px]",
                    filter === c.id
                      ? "bg-white/25 text-white"
                      : "bg-bg-tertiary text-ink-muted",
                  )}
                >
                  {c.count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {view === "list" && (
        <fieldset className="mb-md grid gap-xs rounded-sm border border-border bg-white p-sm sm:grid-cols-2 lg:grid-cols-5">
          <legend className="sr-only">Inventory filters and sorting</legend>
          <FilterSelect
            label="Colour"
            value={colour}
            onChange={(value) => setColour(value as CellarColour | "all")}
            options={[
              { value: "all", label: "All colours" },
              ...CELLAR_COLOURS.map((value) => ({
                value,
                label: value === "rose" ? "Rosé" : `${value[0].toUpperCase()}${value.slice(1)}`,
              })),
            ]}
          />
          <FilterSelect
            label="Region or country"
            value={location}
            onChange={setLocation}
            options={[
              { value: "", label: "All locations" },
              ...locationOptions.map((value) => ({ value, label: value })),
            ]}
          />
          <label className="flex flex-col gap-2xs text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Vintage range
            <span className="grid grid-cols-2 gap-2xs">
              <input
                type="number"
                inputMode="numeric"
                aria-label="Minimum vintage"
                placeholder="From"
                value={vintageMin}
                onChange={(event) => setVintageMin(event.target.value)}
                className="h-9 min-w-0 rounded-sm border border-border px-sm text-[13px] font-normal normal-case tracking-normal text-ink"
              />
              <input
                type="number"
                inputMode="numeric"
                aria-label="Maximum vintage"
                placeholder="To"
                value={vintageMax}
                onChange={(event) => setVintageMax(event.target.value)}
                className="h-9 min-w-0 rounded-sm border border-border px-sm text-[13px] font-normal normal-case tracking-normal text-ink"
              />
            </span>
          </label>
          <FilterSelect
            label="Sort by"
            value={sort}
            onChange={(value) => setSort(value as CellarSort)}
            options={[
              { value: "name", label: "Name (A–Z)" },
              { value: "price", label: "Price (high–low)" },
              { value: "vintage", label: "Vintage (new–old)" },
              { value: "quantity", label: "Quantity (high–low)" },
            ]}
          />
          <button
            type="button"
            onClick={() => {
              setColour("all");
              setLocation("");
              setVintageMin("");
              setVintageMax("");
              setSort("name");
            }}
            className="self-end h-9 rounded-sm border border-border px-sm text-[12px] font-medium text-ink-muted hover:bg-surface-muted"
          >
            Clear inventory filters
          </button>
        </fieldset>
      )}

      {/* Reconcile entry */}
      {view === "list" && canManage && reconcileItems.length > 0 && (
        <button
          type="button"
          onClick={() => setReconcileOpen(true)}
          className="mb-md flex h-[40px] w-full items-center justify-center rounded-sm border border-border-strong bg-white text-[13px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft md:w-auto md:px-md"
        >
          Reconcile {reconcileItems.length} open bottle
          {reconcileItems.length === 1 ? "" : "s"} →
        </button>
      )}

      {/* Main view */}
      {view === "list" ? (
        <CellarList
          rows={rows}
          query={debouncedQuery}
          filter={filter}
          lowStockThreshold={cellarConfig?.lowStockThreshold ?? 3}
          inventoryViewOptions={inventoryViewOptions}
          onSelectWine={(row) => setSelectedId(row.wine_id)}
          onResetFilters={() => {
            setFilter("all");
            setQuery("");
            setColour("all");
            setLocation("");
            setVintageMin("");
            setVintageMax("");
            setSort("name");
          }}
          sections={cellarSections}
        />
      ) : cellarConfig ? (
        <CellarGridView
          config={cellarConfig}
          gridData={gridData}
          truncated={gridTruncated}
        />
      ) : (
        <CellarSetup restaurantName={restaurantName} />
      )}

      {/* Mobile search overlay */}
      {searchOpen && (
        <div className="fixed inset-x-0 top-14 z-30 border-b border-border bg-surface px-md py-sm shadow-md md:hidden">
          <div className="flex items-center gap-sm">
            <SearchInput
              value={query}
              onChange={setQuery}
              inputRef={searchInputRef}
              autoFocus
              onEscape={() => setSearchOpen(false)}
            />
            <button
              type="button"
              onClick={() => setSearchOpen(false)}
              className="h-[38px] rounded-sm px-sm text-[13px] font-medium text-ink-muted hover:bg-surface-muted"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Drawer + modals */}
      <WineDetailDrawer
        key={selectedId ?? "none"}
        row={selected}
        canManage={canManage}
        isOwner={isOwner}
        onClose={() => setSelectedId(null)}
      />

      <ReconcileModal
        open={reconcileOpen}
        items={reconcileItems}
        varianceThresholdOz={cellarConfig?.reconcileVarianceThresholdOz ?? 1.0}
        onClose={() => setReconcileOpen(false)}
      />

      {isOwner && (
        <AutoEightysixModal
          open={settingsOpen}
          restaurantId={restaurantId}
          defaultTargetPourCostPct={defaultTargetPourCostPct}
          defaultTargetMarkupRatio={defaultTargetMarkupRatio}
          enabled={autoEightysixEnabled}
          thresholdMl={autoEightysixThresholdMl}
          eightysixStrategy={eightysixStrategy}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </section>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-2xs text-[11px] font-medium uppercase tracking-wide text-ink-muted">
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-sm border border-border bg-white px-sm text-[13px] font-normal normal-case tracking-normal text-ink"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SearchInput({
  value,
  onChange,
  inputRef,
  autoFocus,
  onEscape,
}: {
  value: string;
  onChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  onEscape?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const showHint = !value && !focused;
  return (
    <div className="relative w-full md:w-[320px]">
      <Search
        className="pointer-events-none absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle"
        strokeWidth={2}
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (value) {
              e.preventDefault();
              onChange("");
            } else if (onEscape) {
              e.preventDefault();
              onEscape();
            }
          }
        }}
        placeholder="Search name, producer, varietal, region, vintage…"
        autoFocus={autoFocus}
        className="h-[38px] w-full rounded-sm border border-border bg-white pl-[32px] pr-[36px] text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="absolute right-2xs top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-ink-muted focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-accent-soft"
        >
          <X className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      ) : (
        showHint && (
          <kbd
            aria-hidden
            className="pointer-events-none absolute right-sm top-1/2 hidden h-[20px] -translate-y-1/2 items-center rounded-sm border border-border bg-surface-muted px-2xs font-mono text-[11px] text-ink-subtle md:inline-flex"
          >
            /
          </kbd>
        )
      )}
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
        "flex h-9 w-9 items-center justify-center text-ink-muted transition-colors",
        active && "bg-accent-soft text-accent",
        !active && "hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={2} aria-hidden />
    </button>
  );
}
