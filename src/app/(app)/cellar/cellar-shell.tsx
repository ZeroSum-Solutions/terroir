"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Search, Settings, LayoutGrid, List as ListIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isClosingWindow, isHolding } from "@/lib/drink-window/status";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import type { CellarWineRow } from "./types";
import { CellarList, type CellarFilter } from "./cellar-list";
import { WineDetailDrawer } from "./wine-detail-drawer";
import { ReconcileModal } from "./reconcile-modal";
import { AutoEightysixModal } from "./auto-eightysix-modal";
import { CellarGridView, CellarSetup } from "./cellar-grid";

/**
 * CellarShell — top-level client orchestrator for the consolidated
 * Cellar surface (Phase 2 IA redesign — .council/specs/2026-04-24-ux-ia-redesign.md).
 *
 * Owns top-level UI state:
 *   • search query
 *   • filter chip
 *   • view toggle (list | grid)
 *   • selected wine for detail drawer
 *   • reconcile modal open
 *   • settings (auto-86) modal open
 *
 * Reads `?mode=` URL param on mount to land in a useful state when the
 * user got here via the FAB:
 *   ?mode=pour       → focuses search, filter = "open"
 *   ?mode=eightysix  → focuses search, filter = "all"
 *
 * The param is stripped after read so refreshes don't re-trigger.
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
  defaultTargetPourCostPct,
  defaultTargetMarkupRatio,
  role,
}: {
  rows: CellarWineRow[];
  reconcileItems: OpenBottleRow[];
  cellarConfig: { id: string; rows: number; columns: number; name: string } | null;
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
  // BND-040 follow-up — house pricing targets piped into the Cellar
  // settings modal. Null means restaurant has never set them; the
  // panel falls back to built-in defaults (22% pour cost / 2.7× markup).
  defaultTargetPourCostPct: number | null;
  defaultTargetMarkupRatio: number | null;
  role: "owner" | "manager" | "staff";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // FAB deep-link mode + briefing-card wine deep-link are sampled
  // exactly once on mount via useState's lazy initializer. State never
  // updates — these are stable mount-time snapshots. (Using useRef
  // would trip react-hooks/refs lint about render-time ref reads.)
  //
  // BND-039 — `?wine={id}` deep-link from Insights briefing cards
  // auto-opens the wine-detail drawer for the alerted wine. This is
  // the spec's primary CTA on the briefing alert; without it the user
  // tap-throughs to an unfiltered list and can't find the bottles.
  const [initialMode] = useState(() => searchParams.get("mode") ?? "");
  const [initialWineId] = useState(() => searchParams.get("wine") ?? "");

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CellarFilter>(
    initialMode === "pour" ? "open" : "all",
  );
  const [view, setView] = useState<"list" | "grid">("list");
  // Derive selected from selectedId so server-component refresh refreshes
  // the drawer's stock numbers automatically (rows is the source of truth).
  // BND-039: when the user lands here via a briefing-card "View bottles"
  // deep-link (?wine={id}), auto-open the drawer for that wine.
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

  // Deep-link side-effects: strip `?mode=` and `?wine=` from the URL
  // so a refresh doesn't re-trigger the focus jump or re-open the
  // drawer, and focus the search input once it's mounted (FAB flow
  // only). Purely external (router + DOM) so setState-in-effect lint
  // doesn't apply.
  useEffect(() => {
    if (!initialMode && !initialWineId) return;
    if (initialMode === "pour" || initialMode === "eightysix") {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete("mode");
    params.delete("wine");
    const next = params.toString();
    router.replace(next ? `/cellar?${next}` : "/cellar", { scroll: false });
    // Run once at mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "/" focuses the search input (GitHub-style shortcut). Skipped when
  // the user is already typing in a form field or contenteditable so
  // the literal slash still types in those contexts. On mobile the
  // search input is unmounted until the overlay is open, so we open
  // the overlay and rely on its `autoFocus` to land focus.
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
        // Mobile: search input not yet mounted — open the overlay,
        // which auto-focuses on mount.
        setSearchOpen(true);
      }
    }
    document.addEventListener("keydown", handleSlash);
    return () => document.removeEventListener("keydown", handleSlash);
  }, []);

  const alerts = useMemo(() => {
    // Show alerts banner when there are recently-86'd wines or any low
    // stock items. Compact summary; the actual filter chips do the
    // detailed work.
    //
    // Open/out/low predicates mirror CellarList's filter switch so the
    // chip badges always equal the actual filtered list size.
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

    // BND-039 — count of wines closing their drink window. Single source
    // of truth via @/lib/drink-window/status; the same predicate powers
    // the "Drink now" filter chip and the briefing alert API.
    //
    // Both Drink-now and Hold counts exclude 86'd wines: a sold-out
    // wine isn't an actionable hold/drink-soon decision the operator
    // can do anything about. Code-quality-review finding 3 — consistency.
    const drinkNowCount = rows.filter(
      (r) => !r.is_eightysixed && isClosingWindow(r.drink_window_end),
    ).length;
    const holdCount = rows.filter(
      (r) => !r.is_eightysixed && isHolding(r.drink_window_start),
    ).length;

    return { openCount, outCount, lowCount, drinkNowCount, holdCount };
  }, [rows]);

  const FILTER_CHIPS: Array<{ id: CellarFilter; label: string; count?: number }> = [
    { id: "all", label: "All" },
    { id: "open", label: "Open", count: alerts.openCount },
    { id: "out", label: "86'd", count: alerts.outCount },
    { id: "low", label: "Low stock", count: alerts.lowCount },
    // BND-039 — drink-window chips. Hidden when count is zero so they
    // don't clutter the row in cellars without enrichment data.
    ...(alerts.drinkNowCount > 0
      ? [{ id: "drink-now" as const, label: "Drink now", count: alerts.drinkNowCount }]
      : []),
    ...(alerts.holdCount > 0
      ? [{ id: "hold" as const, label: "Hold", count: alerts.holdCount }]
      : []),
  ];

  return (
    <section>
      {/* Header — search trigger, view toggle, settings cog, reconcile */}
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

        {/* Desktop search inline */}
        <div className="hidden md:block">
          <SearchInput
            value={query}
            onChange={setQuery}
            inputRef={searchInputRef}
          />
        </div>

        <div className="flex items-center gap-2xs">
          {/* Mobile search trigger */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search wines"
            className="flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted md:hidden"
          >
            <Search className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>

          {/* View toggle — only meaningful when cellarConfig exists */}
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

          {/* Settings cog — owner only */}
          {isOwner && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Cellar settings"
              className="flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted"
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
                  : "border-border bg-white text-ink-muted hover:bg-surface-muted",
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

      {/* Reconcile entry — only for owner/manager and only on list view */}
      {view === "list" && canManage && reconcileItems.length > 0 && (
        <button
          type="button"
          onClick={() => setReconcileOpen(true)}
          className="mb-md flex h-[40px] w-full items-center justify-center rounded-sm border border-border-strong bg-white text-[13px] font-medium text-ink hover:bg-surface-muted md:w-auto md:px-md"
        >
          Reconcile open bottles →
        </button>
      )}

      {/* Main view */}
      {view === "list" ? (
        <CellarList
          rows={rows}
          query={query}
          filter={filter}
          onSelectWine={(row) => setSelectedId(row.wine_id)}
          onResetFilters={() => {
            setFilter("all");
            setQuery("");
          }}
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

      {/* Drawer + modals. Keying on selectedId remounts the drawer when
          the user picks a different wine, which cleanly resets the
          drawer's transient state (busy, error, picker, 86 confirm)
          without needing setState-in-effect. */}
      <WineDetailDrawer
        key={selectedId ?? "none"}
        row={selected}
        canManage={canManage}
        onClose={() => setSelectedId(null)}
      />

      <ReconcileModal
        open={reconcileOpen}
        items={reconcileItems}
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
  // Mobile overlay passes this to also close the overlay on Escape.
  // When the field has text, Escape clears the text first; a second
  // Escape (now on an empty field) fires onEscape.
  onEscape?: () => void;
}) {
  // Show the "/" shortcut hint only when the field is empty and not
  // focused — otherwise the kbd visually competes with the clear-X
  // button or the user's typing.
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
        !active && "hover:bg-surface-muted",
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={2} aria-hidden />
    </button>
  );
}
