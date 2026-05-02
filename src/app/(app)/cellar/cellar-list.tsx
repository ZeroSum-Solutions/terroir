"use client";

import { useMemo } from "react";
import Link from "next/link";
import { MoreVertical, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { ML_PER_OZ } from "@/lib/units";
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
 * Each row collapses what used to live across three tabs:
 *   - Pour:        glass-count chip + remaining ml
 *   - Availability: 86'd status chip
 *   - Cellar grid:  bin location
 *
 * Tap a row → opens the wine-detail-drawer with quick action buttons.
 * Tap the kebab → quick actions without opening the drawer (pour now,
 * 86 toggle, etc.). The kebab routing is handled by the parent shell —
 * this component only renders rows and emits intents.
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

// Human-readable labels for filter chips, shown in the empty-results
// state so the user can see exactly which filter is excluding their
// wines. Keep in sync with FILTER_CHIPS in cellar-shell.tsx.
const FILTER_LABELS: Record<Exclude<CellarFilter, "all">, string> = {
  open: "Open",
  out: "86'd",
  low: "Low stock",
  "off-site": "Off-site",
  "drink-now": "Drink now",
  hold: "Hold",
};

export function CellarList({
  rows,
  query,
  filter,
  onSelectWine,
  onResetFilters,
}: {
  rows: CellarWineRow[];
  query: string;
  filter: CellarFilter;
  onSelectWine: (row: CellarWineRow) => void;
  // Called when the user taps the empty-state "Clear filter & search"
  // button. The parent shell owns query + filter state.
  onResetFilters: () => void;
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      // Filter chip predicate
      switch (filter) {
        case "open":
          if (r.open_remaining_ml === null || r.open_remaining_ml <= 0) return false;
          break;
        case "out":
          if (!r.is_eightysixed) return false;
          break;
        case "low": {
          // Low stock heuristic: total available equivalents < 2 bottles.
          // Treat a wine without size_ml as "not low" since we have no
          // basis for the check.
          if (!r.size_ml) return false;
          const totalMl = (r.open_remaining_ml ?? 0) + r.sealed_count * r.size_ml;
          if (totalMl >= 2 * r.size_ml) return false;
          if (r.is_eightysixed) return false; // already out, not "low"
          break;
        }
        case "off-site":
          // v1.5 — off-site inventory not yet modeled. Show empty for now.
          return false;
        case "drink-now":
          // BND-039 — wines within 2 years of window close (or past peak).
          // Single source of truth in @/lib/drink-window/status to keep
          // chip-count and list-filter from drifting.
          if (!isClosingWindow(r.drink_window_end)) return false;
          if (r.is_eightysixed) return false;
          break;
        case "hold":
          if (!isHolding(r.drink_window_start)) return false;
          // Exclude 86'd wines from Hold filter: a sold-out wine isn't
          // an actionable hold decision (matches drink-now predicate).
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
      message = `No wines match “${trimmedQuery}” in ${filterLabel}.`;
    } else if (trimmedQuery) {
      message = `No wines match “${trimmedQuery}”.`;
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
          Clear filter &amp; search
        </button>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-white">
      {filtered.map((row) => (
        <CellarRow key={row.wine_id} row={row} onSelect={() => onSelectWine(row)} />
      ))}
    </ul>
  );
}

function CellarRow({
  row,
  onSelect,
}: {
  row: CellarWineRow;
  onSelect: () => void;
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

  // Stock chip choices map directly to spec §4 examples:
  //   ⚪ Open · 380ml · Bin C-4
  //   ● 2 sealed · Bin A-12
  //   ⚫ 86'd · sold out
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
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="w-full px-md py-md text-left transition-colors hover:bg-surface-muted/40"
      >
        <div className="flex items-start justify-between gap-md">
          <div className="min-w-0 flex-1">
            {/* Producer · Vintage · Region — small caps */}
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
              <span className="text-ink-muted">{row.producer}</span>
              {row.vintage && <span className="ml-xs font-mono">{row.vintage}</span>}
              {row.region && <span className="ml-xs">· {row.region}</span>}
            </div>
            {/* Wine name — display font */}
            <div className="mt-2xs font-serif text-[16px] text-ink">{row.name}</div>
            {/* Stock + drink-window + bin row */}
            <div className="mt-xs flex flex-wrap items-center gap-sm text-[12px] text-ink-muted">
              <Chip tone={chip.tone}>{chip.label}</Chip>
              {glassesLeft !== null && glassesLeft > 0 && !row.is_eightysixed && (
                <span className="text-ink-muted">
                  ~{glassesLeft} glass{glassesLeft === 1 ? "" : "es"} left
                </span>
              )}
              {/* BND-039 — mini drink-window indicator. Renders only when
                  we have a window AND the wine isn't 86'd (an 86'd wine's
                  drink-window status is overridden by its sold-out state). */}
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
          <span
            aria-hidden
            className="mt-2xs flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-ink-subtle"
          >
            <MoreVertical className="h-4 w-4" strokeWidth={2} />
          </span>
        </div>
      </button>
    </li>
  );
}

/**
 * BND-039 — mini drink-window indicator for the cellar row.
 *
 * Shows a 56px gradient bar with a current-year marker + a status
 * pill ("Drink now · 4 yrs", "Hold · ready 2027", etc.). The pill
 * uses the same status-derived tone as the drawer's full timeline so
 * the two surfaces feel consistent. Returns null when the wine has
 * no window data — these rows render normally without the indicator.
 */
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

  // Tone:
  //   drink_now / past_peak → warn (amber)
  //   hold                  → muted (grey)
  //   optimal               → ok (green)
  //   unknown               → muted
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
