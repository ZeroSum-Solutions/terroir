"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { isClosingWindow, isHolding } from "@/lib/drink-window/status";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import type { CellarWineRow } from "./types";
import { CellarList, FILTER_LABELS } from "./cellar-list";
import { drawerStateKey, WineDetailDrawer } from "./wine-detail-drawer";
import { ReconcileModal } from "./reconcile-modal";
import { AutoEightysixModal } from "./auto-eightysix-modal";
import { CellarGridView, CellarSetup } from "./cellar-grid";
import type { GridData } from "./grid-types";
import { resolveCellarNavigationIntent } from "./cellar-navigation";
import { useCellarUrlState } from "./use-cellar-url-state";
import { buildCellarCounters } from "./cellar-counters";
import { CellarControlBar } from "./cellar-control-bar";
import { VoiceCellarControl } from "./voice-cellar-control";

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
  gridData: GridData;
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
  const searchParams = useSearchParams();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const mode = searchParams.get("mode");
  const { urlState, urlStateRef, applyUrlState, replaceUrlState } =
    useCellarUrlState();
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
  }, [qDraft, replaceUrlState, urlStateRef]);

  // The view is URL state (CELLAR-08): `/cellar?view=grid` is linkable, and
  // the bin grid stops being unreachable on a phone, where the List/Grid
  // toggle used to be the only door in and was `md:` only.
  const view = urlState.view;

  // D2 (Kimi audit 2026-08-26) — the hero keeps its ceremony, then hands
  // off to a compact sticky masthead once it scrolls away: count, active
  // filter, search, and the sort control stay in reach on a 1,364-bottle
  // list. A sentinel under the bridge band drives the swap.
  const [stuck, setStuck] = useState(false);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const mastheadSearchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const el = sentinelRef.current;
    if (!el) {
      setStuck(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting),
      // Account for the 54px glass app header the sentinel slides under.
      { rootMargin: "-54px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);
  const selected = useMemo(
    () =>
      urlState.wine
        ? rows.find((row) => row.wine_id === urlState.wine) ?? null
        : null,
    [rows, urlState.wine],
  );
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // CELLAR-01 — every facet, the sort and the grouping now live behind one
  // surface, opened from the single control row.
  const [filtersOpen, setFiltersOpen] = useState(false);

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
      // Search is always on screen now, so the FAB's intent focuses it rather
      // than raising an overlay that duplicated the same input.
      if (intent.shouldFocusSearch) searchInputRef.current?.focus();
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
      input?.focus();
      input?.select();
    }
    document.addEventListener("keydown", handleSlash);
    return () => document.removeEventListener("keydown", handleSlash);
  }, []);

  const alerts = useMemo(() => {
    const totalBottles = rows.reduce((acc, r) => acc + r.sealed_count, 0);
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

    // Must match the "drink-now" list filter predicate (isClosingWindow) —
    // it previously counted only past_peak, so the chip said 147 while the
    // filter it opened showed 174 (Kimi audit 2026-08-26).
    const drinkNowCount = rows.filter(
      (r) => !r.is_eightysixed && isClosingWindow(r.drink_window_end),
    ).length;
    const holdCount = rows.filter(
      (r) => !r.is_eightysixed && isHolding(r.drink_window_start),
    ).length;

    return { totalBottles, openCount, outCount, lowCount, drinkNowCount, holdCount };
  }, [rows]);

  const counters = useMemo(() => {
    const built = buildCellarCounters(alerts);
    // `buildCellarCounters` suppresses zero-count scopes — a filter to nothing
    // is noise. As pills that read as "no pill is selected"; as ONE select it
    // would read as "All" while the list is filtered to nothing, because a
    // select cannot display a value it has no option for. So the active scope
    // always gets an option, whatever its count.
    if (urlState.filter === "all" || built.some((c) => c.id === urlState.filter)) {
      return built;
    }
    return [
      ...built,
      { id: urlState.filter, label: FILTER_LABELS[urlState.filter], value: 0 },
    ];
  }, [alerts, urlState.filter]);
  // Everything the one filter surface now owns: the facets, the grouping and
  // the sort. Counted from the URL alone so the badge needs no row data.
  const activeFilterCount =
    (urlState.producer ? 1 : 0) +
    (urlState.region ? 1 : 0) +
    (urlState.country ? 1 : 0) +
    (urlState.varietal ? 1 : 0) +
    (urlState.vintageMin != null || urlState.vintageMax != null ? 1 : 0) +
    (urlState.format != null ? 1 : 0) +
    (urlState.health ? 1 : 0) +
    (urlState.groupBy ? 1 : 0) +
    (urlState.sort ? 1 : 0);
  const selectCounter = useCallback(
    (filter: (typeof counters)[number]["id"]) => {
      // Counters stay visible (and functional) in Grid view too, since
      // they're also the hero's KPI display — tapping one switches back
      // to the filtered List view rather than looking like a dead control.
      replaceUrlState({ filter, view: "list" });
    },
    [replaceUrlState],
  );

  return (
    <section className="min-w-0 max-w-full overflow-x-hidden">
      {/* Dawn Hero */}
      <div className="-mx-md -mt-lg dawn-gradient px-md pb-lg pt-lg max-[359px]:pb-xs max-[359px]:pt-xs md:-mx-lg md:-mt-xl md:px-lg md:pb-2xl md:pt-xl">
        <p className="truncate text-caption font-medium uppercase text-grey">
          {restaurantName} · Cellar
        </p>
        <h1 className="mt-xs max-w-[560px] font-serif text-heading-sm font-light leading-[1.1] text-ink max-[359px]:mt-2xs max-[359px]:text-[22px] md:text-heading lg:max-w-[820px] lg:text-display">
          A cellar beyond the <em className="italic font-normal text-mark">ordinary</em>
        </h1>
      </div>

      {/* Search — GLOBAL-02 lifts it out of the control row and puts it above,
          on its own, at every width. The mobile search icon and its overlay are
          gone with it: they existed only because the input had no room in the
          old four-row stack. */}
      <div className="-mx-md bg-surface-sunken px-md pt-sm md:-mx-lg md:px-lg">
        <div className="flex items-center gap-xs">
          <div className="min-w-0 flex-1 md:max-w-[420px]">
            <SearchInput
              value={qDraft}
              onChange={setQDraft}
              inputRef={searchInputRef}
            />
          </div>
          <VoiceCellarControl
            onResolve={(wineId) => {
              applyUrlState({ view: "list", wine: wineId }, "push");
            }}
            onFilter={(filters) => {
              applyUrlState(
                {
                  view: "list",
                  ...(filters.country !== undefined ? { country: filters.country } : {}),
                  ...(filters.region !== undefined ? { region: filters.region } : {}),
                  ...(filters.varietal !== undefined ? { varietal: filters.varietal } : {}),
                  ...(filters.filter !== undefined ? { filter: filters.filter } : {}),
                  ...(filters.search !== undefined ? { q: filters.search } : {}),
                },
                "push",
              );
            }}
          />
        </div>
      </div>

      {/* The one control row (CELLAR-01 / GLOBAL-01) */}
      <CellarControlBar
        counters={counters}
        activeFilter={urlState.filter}
        onSelectFilter={selectCounter}
        activeFilterCount={activeFilterCount}
        onOpenFilters={() => setFiltersOpen(true)}
        openBottleCount={alerts.openCount}
        reconcileCount={
          view === "list" && canManage ? reconcileItems.length : 0
        }
        onReconcile={() => setReconcileOpen(true)}
        view={view}
        onViewChange={(next) => replaceUrlState({ view: next })}
        showViewToggle={cellarConfig !== null}
        showSettings={isOwner}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Sticky-masthead sentinel — when this scrolls under the app
          header, the hero has left the stage and the compact masthead
          takes over. */}
      {view === "list" && <div ref={sentinelRef} aria-hidden className="h-px" />}

      {/* Compact sticky masthead (D2) — the same two exempt/primary controls
          the page leads with: search, and the one filter surface. */}
      {view === "list" && stuck && (
        <div className="glass fixed inset-x-0 top-[var(--chrome-header-total)] z-[var(--z-chrome)]">
          {/* Marked as a control row so the runtime gate can SEE it. The
              static gate counts this and CellarControlBar as two rows; they
              never coexist in a frame, because `stuck` only becomes true once
              the control bar has scrolled off. e2e/cellar-control-row.test.ts
              is what actually enforces Devin's rule — exactly one control row
              intersecting the viewport, at any scroll position. */}
          <div
            data-cellar-control-row
            data-cellar-masthead
            className="mx-auto flex w-full max-w-[1160px] items-center gap-sm px-md py-xs md:px-lg"
          >
            <p className="hidden min-w-0 flex-1 truncate text-ledger text-grey sm:block">
              <span className="font-medium tabular text-ink">
                {(filteredCount ?? rows.length).toLocaleString()}
              </span>{" "}
              {urlState.filter === "all"
                ? "wines"
                : FILTER_LABELS[urlState.filter].toLocaleLowerCase()}
            </p>
            <div className="min-w-0 flex-1 sm:max-w-[280px]">
              <SearchInput
                value={qDraft}
                onChange={setQDraft}
                inputRef={mastheadSearchRef}
              />
            </div>
            {urlState.filter !== "all" && (
              <button
                type="button"
                onClick={() => replaceUrlState({ filter: "all" })}
                className="inline-flex h-11 shrink-0 items-center gap-2xs whitespace-nowrap rounded-pill border border-edge px-sm text-caption font-medium tracking-normal text-ink hover:bg-surface/60 focus-ring"
              >
                {FILTER_LABELS[urlState.filter]}
                <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className="inline-flex h-11 shrink-0 items-center gap-xs whitespace-nowrap rounded-pill border border-edge bg-surface px-sm text-ledger font-medium text-ink hover:bg-wash focus-ring"
            >
              Filters
              {activeFilterCount > 0 && (
                <span className="tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-primary px-xs text-micro text-seal-ink">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Alerts banner */}
      {alerts.lowCount > 0 && view === "list" && (
        <div
          role="status"
          className="mb-md flex items-center justify-between gap-md rounded-md border border-rule bg-risk-wash px-md py-sm text-body-sm text-risk-ink"
        >
          <span>
            {alerts.lowCount} wine{alerts.lowCount === 1 ? "" : "s"} low on stock
          </span>
          <button
            type="button"
            onClick={() => replaceUrlState({ filter: "low" })}
            className="inline-flex min-h-11 items-center rounded-pill border border-risk-ink/30 px-sm text-[11.5px] font-medium text-risk-ink hover:bg-surface/60"
          >
            Show
          </button>
        </div>
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
          sort={urlState.sort}
          onFacetsChange={replaceUrlState}
          onGroupByChange={(groupBy) => replaceUrlState({ groupBy })}
          onSortChange={(sort) => replaceUrlState({ sort })}
          onFilteredCountChange={setFilteredCount}
          filtersOpen={filtersOpen}
          onFiltersOpenChange={setFiltersOpen}
          sections={cellarSections}
        />
      ) : cellarConfig ? (
        <CellarGridView config={cellarConfig} gridData={gridData} onSelectWine={openWine} />
      ) : (
        <CellarSetup restaurantName={restaurantName} />
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
    <div className="relative w-full">
      <Search
        className="pointer-events-none absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-grey"
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
        className="h-11 w-full rounded-pill border border-edge bg-surface/70 pl-[32px] pr-[36px] text-[13px] text-ink outline-none placeholder:text-grey focus-visible:border-accent focus-ring"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-pill text-grey hover:bg-surface/60 hover:text-ink-soft focus-ring"
        >
          <X className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      ) : (
        showHint && (
          <kbd
            aria-hidden
            className="pointer-events-none absolute right-sm top-1/2 hidden h-[20px] -translate-y-1/2 items-center rounded-md border border-rule bg-surface/60 px-2xs font-sans text-[11px] text-grey md:inline-flex"
          >
            /
          </kbd>
        )
      )}
    </div>
  );
}
