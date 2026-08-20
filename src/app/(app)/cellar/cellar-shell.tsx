"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Search, Settings, LayoutGrid, List as ListIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getDrinkWindowStatus, isHolding } from "@/lib/drink-window/status";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import type { CellarWineRow } from "./types";
import { CellarList } from "./cellar-list";
import { drawerStateKey, WineDetailDrawer } from "./wine-detail-drawer";
import { ReconcileModal } from "./reconcile-modal";
import { AutoEightysixModal } from "./auto-eightysix-modal";
import { CellarGridView, CellarSetup } from "./cellar-grid";
import { resolveCellarNavigationIntent } from "./cellar-navigation";
import {
  parseCellarUrlState,
  serializeCellarUrlState,
  type CellarUrlFilter,
  type CellarUrlState,
} from "@/lib/cellar-facets/url-state";

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
  const urlState = useMemo(
    () => parseCellarUrlState(searchParams),
    [searchParams],
  );
  const urlStateRef = useRef(urlState);
  useEffect(() => {
    urlStateRef.current = urlState;
  }, [urlState]);
  const applyUrlState = useCallback(
    (patch: Partial<CellarUrlState>, mode: "replace" | "push") => {
      const next = { ...urlStateRef.current, ...patch };
      urlStateRef.current = next;
      const params = serializeCellarUrlState(next);
      const href = `/cellar?${params.toString()}`;
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [router],
  );
  const replaceUrlState = useCallback(
    (patch: Partial<CellarUrlState>) => applyUrlState(patch, "replace"),
    [applyUrlState],
  );
  // Opening the drawer pushes a history entry so Back closes it.
  const openWine = useCallback(
    (wineId: string) => applyUrlState({ wine: wineId }, "push"),
    [applyUrlState],
  );

  // A deep-linked wine id that doesn't exist in this cellar would otherwise
  // pin a dead wine= param to the URL with no visible way to clear it.
  useEffect(() => {
    if (urlState.wine && !rows.some((row) => row.wine_id === urlState.wine)) {
      replaceUrlState({ wine: null });
    }
  }, [urlState.wine, rows, replaceUrlState]);

  // Search input draft: filters client-side per keystroke, syncs to the URL
  // on a debounce so typing doesn't trigger an RSC refetch per character.
  const [qDraft, setQDraft] = useState(urlState.q);
  const lastPushedQ = useRef(urlState.q);
  useEffect(() => {
    if (urlState.q !== lastPushedQ.current) {
      lastPushedQ.current = urlState.q;
      setQDraft(urlState.q);
    }
  }, [urlState.q]);
  useEffect(() => {
    if (qDraft === urlStateRef.current.q) return;
    const id = setTimeout(() => {
      lastPushedQ.current = qDraft;
      replaceUrlState({ q: qDraft });
    }, 250);
    return () => clearTimeout(id);
  }, [qDraft, replaceUrlState]);

  const [initialMode] = useState(() => mode ?? "");
  const [view, setView] = useState<"list" | "grid">("list");
  const selected = useMemo(
    () =>
      urlState.wine
        ? rows.find((row) => row.wine_id === urlState.wine) ?? null
        : null,
    [rows, urlState.wine],
  );
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(
    initialMode === "pour" || initialMode === "eightysix",
  );

  const canManage = role === "owner" || role === "manager";
  const isOwner = role === "owner";

  useEffect(() => {
    const intent = resolveCellarNavigationIntent(
      mode,
      null,
      new Set(rows.map((row) => row.wine_id)),
    );
    if (!intent.shouldConsumeParams) return;

    const frame = requestAnimationFrame(() => {
      if (intent.shouldFocusSearch) setSearchOpen(true);
      replaceUrlState({ filter: intent.filter ?? urlState.filter });
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [mode, replaceUrlState, rows, urlState.filter]);

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
      if (r.is_eightysixed) return false;
      if (!r.size_ml) return false;
      const totalMl = (r.open_remaining_ml ?? 0) + r.sealed_count * r.size_ml;
      return totalMl < 2 * r.size_ml;
    }).length;

    const drinkNowCount = rows.filter(
      (r) => !r.is_eightysixed && getDrinkWindowStatus(r.drink_window_start, r.drink_window_end) === "past_peak",
    ).length;
    const holdCount = rows.filter(
      (r) => !r.is_eightysixed && isHolding(r.drink_window_start),
    ).length;

    return { openCount, outCount, lowCount, drinkNowCount, holdCount };
  }, [rows]);

  const FILTER_CHIPS: Array<{ id: CellarUrlFilter; label: string; count?: number }> = [
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
            value={qDraft}
            onChange={setQDraft}
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
            onClick={() => replaceUrlState({ filter: "low" })}
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
              aria-selected={urlState.filter === c.id}
              onClick={() => replaceUrlState({ filter: c.id })}
              className={cn(
                "inline-flex h-[32px] shrink-0 items-center gap-xs rounded-full border px-md text-[12px] font-medium transition-colors",
                urlState.filter === c.id
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-white text-ink-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
              )}
            >
              {c.label}
              {c.count !== undefined && (
                <span
                  className={cn(
                    "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-xs font-mono text-[10px]",
                    urlState.filter === c.id
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
          query={qDraft}
          filter={urlState.filter}
          lowStockThreshold={cellarConfig?.lowStockThreshold ?? 3}
          onSelectWine={(row) => openWine(row.wine_id)}
          onResetFilters={() => {
            replaceUrlState({
              q: "",
              filter: "all",
              producer: null,
              region: null,
              country: null,
              varietal: null,
              vintageMin: null,
              vintageMax: null,
              format: null,
              health: null,
            });
          }}
          facets={{
            producer: urlState.producer,
            region: urlState.region,
            country: urlState.country,
            varietal: urlState.varietal,
            vintageMin: urlState.vintageMin,
            vintageMax: urlState.vintageMax,
            format: urlState.format,
            health: urlState.health,
          }}
          groupBy={urlState.groupBy}
          onFacetsChange={replaceUrlState}
          onGroupByChange={(groupBy) => replaceUrlState({ groupBy })}
          sections={cellarSections}
        />
      ) : cellarConfig ? (
        <CellarGridView config={cellarConfig} gridData={gridData} />
      ) : (
        <CellarSetup restaurantName={restaurantName} />
      )}

      {/* Mobile search overlay */}
      {searchOpen && (
        <div className="fixed inset-x-0 top-14 z-30 border-b border-border bg-surface px-md py-sm shadow-md md:hidden">
          <div className="flex items-center gap-sm">
            <SearchInput
              value={qDraft}
              onChange={setQDraft}
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
        key={drawerStateKey(selected)}
        row={selected}
        canManage={canManage}
        isOwner={isOwner}
        onClose={() => replaceUrlState({ wine: null })}
        duplicateRows={
          selected
            ? rows.filter((r) => selected.duplicate_wine_ids.includes(r.wine_id))
            : undefined
        }
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
        placeholder="Search name, producer, region…"
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
