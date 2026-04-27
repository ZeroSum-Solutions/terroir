"use client";

import { useRef, useState, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, Wine, PowerOff, Edit3, ChevronDown } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { ML_PER_OZ } from "@/lib/units";
import { cn } from "@/lib/utils";
import { NoteModal } from "./note-modal";
import { PourPickerModal } from "./pour-picker-modal";
import { DrinkWindowTimeline } from "@/components/drink-window-timeline";
import { PriceBand } from "@/components/price-band";
import {
  formatStatusLabel,
  getDrinkWindowStatus,
  getYearsUntilWindowClose,
} from "@/lib/drink-window/status";
import {
  formatPricingStatusLabel,
  getBottleStatus,
  getGlassStatus,
  getMarkupRatio,
  getPourCostPct,
  isRetailStale,
  resolveMarkupTarget,
  resolvePourCostTarget,
} from "@/lib/pricing/status";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import type { CellarWineRow } from "./types";

/**
 * WineDetailDrawer — per-wine action panel (Phase 2 IA redesign §4
 * "Per-row behavior"). Opens when the user taps a row in the cellar
 * list. Hosts the quick action buttons that used to be the entry
 * points for /pour and /availability.
 *
 * Mobile: bottom sheet, slides up from the bottom-nav.
 * Desktop: right-side panel that doesn't cover the list.
 *
 * Actions:
 *   • Pour — only when wine has glass_pour_ml. Tap performs the pour
 *     using the wine's default size; long-press / picker caret offers
 *     custom pour sizes (mode = picker).
 *   • 86 / Restore — toggle availability. Opens the note modal first.
 *   • Edit — placeholder for v1.5 metadata editor (admin only).
 */
export function WineDetailDrawer({
  row,
  canManage,
  onClose,
}: {
  row: CellarWineRow | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "wine-detail-heading";
  const [, startTransition] = useTransition();

  // Pour-side local state. Only relevant when row.glass_pour_ml is set.
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 86/restore note-modal flow.
  const [pendingDirection, setPendingDirection] = useState<
    "eightysixed" | "restored" | null
  >(null);

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: onClose,
    enabled: row !== null,
  });
  // Note: parent (CellarShell) keys this component on selectedId, so
  // changing wines remounts and naturally clears transient state. No
  // reset effect needed.

  const doPour = useCallback(
    async (ml: number) => {
      if (!row || !row.glass_pour_ml) return;
      setErrorMsg(null);
      setBusy(true);

      // We let the server reconcile via router.refresh after a
      // successful pour. The drawer doesn't do an optimistic update —
      // /api/pour returns quickly and the spinner busy-state covers
      // the brief gap. (The /pour grid did optimistic + cascade
      // prediction; the drawer's single-action surface doesn't need
      // that complexity.)
      try {
        const res = await fetch("/api/pour", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wine_id: row.wine_id, ml, kind: "pour" }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(payload?.error ?? `Request failed (${res.status}).`);
        }
        startTransition(() => router.refresh());
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Pour failed.");
      } finally {
        setBusy(false);
      }
    },
    [row, router],
  );

  const onConfirm86 = async (note: string | undefined) => {
    if (!row || !pendingDirection) return;
    const direction = pendingDirection;
    setPendingDirection(null);
    setErrorMsg(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/wines/${row.wine_id}/availability`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, note }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Request failed (${res.status}).`);
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Toggle failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!row) return null;

  // Construct a synthetic OpenBottleRow shape for the picker modal (it
  // expects the RPC row shape).
  const pickerItem: OpenBottleRow | null =
    row.wine_list_item_id && row.glass_pour_ml && row.size_ml
      ? {
          wine_id: row.wine_id,
          name: row.name,
          producer: row.producer,
          vintage: row.vintage as number,
          glass_pour_ml: row.glass_pour_ml,
          open_remaining_ml: row.open_remaining_ml as number,
          opened_at: row.opened_at as string,
          pour_size_mode: row.pour_size_mode ?? "fixed",
          sealed_count: row.sealed_count,
          size_ml: row.size_ml,
          wine_list_item_id: row.wine_list_item_id,
        }
      : null;

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

  const canPour = !!row.glass_pour_ml && !row.is_eightysixed;
  const outOfStock = totalMl !== null && row.glass_pour_ml !== null && totalMl < row.glass_pour_ml;

  return (
    <>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 md:items-stretch md:justify-end"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* Mobile: bottom sheet. Desktop: right-side rail. */}
        <div
          className={cn(
            "w-full overflow-hidden border-border bg-surface shadow-lg",
            "max-h-[85vh] rounded-t-md border-x border-t",
            "md:h-full md:max-h-none md:max-w-[420px] md:rounded-none md:border-l md:border-x-0 md:border-t-0",
          )}
        >
          <header className="flex items-start justify-between border-b border-border px-md py-md md:px-lg">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
                <span>{row.producer}</span>
                {row.vintage && <span className="ml-xs font-mono">{row.vintage}</span>}
                {row.region && <span className="ml-xs">· {row.region}</span>}
              </div>
              <h2
                id={headingId}
                className="mt-2xs font-serif text-[20px] text-ink md:text-[22px]"
              >
                {row.name}
              </h2>
              {row.varietal && (
                <p className="mt-2xs text-[12px] text-ink-muted">{row.varietal}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close wine detail"
              className="ml-md flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted"
            >
              <X className="h-5 w-5" strokeWidth={2} aria-hidden />
            </button>
          </header>

          <div
            className="overflow-y-auto px-md py-md md:px-lg md:py-lg"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
          >
            {/* Stock breakdown */}
            <section
              aria-label="Stock"
              className="rounded-md border border-border bg-white p-md"
            >
              <div className="grid grid-cols-3 gap-md text-center">
                <Stat
                  label="Open"
                  value={ozLeft !== null ? `${ozLeft} oz` : "—"}
                />
                <Stat label="Sealed" value={`${row.sealed_count}`} />
                <Stat
                  label="Status"
                  value={row.is_eightysixed ? "86'd" : "Available"}
                  tone={row.is_eightysixed ? "warn" : "ok"}
                />
              </div>
              {glassesLeft !== null && (
                <p className="mt-sm text-center text-[12px] text-ink-muted">
                  ~{glassesLeft} glass{glassesLeft === 1 ? "" : "es"} left
                  {row.glass_pour_ml &&
                    ` · pour size ${(row.glass_pour_ml / ML_PER_OZ).toFixed(1)} oz`}
                </p>
              )}
              {row.bin_location && (
                <p className="mt-2xs text-center font-mono text-[12px] text-ink-subtle">
                  Bin {row.bin_location}
                </p>
              )}
            </section>

            {/* BND-040 — Pricing panel. Renders when retail data is
                available. No verdict pills in the drawer; numbers + targets
                only. Verdicts only appear in outlier-context surfaces
                (Insights pricing review). */}
            {row.retail_median != null && (
              <PricingSection row={row} />
            )}

            {/* BND-039 — Drink window panel. Renders only when we have
                window data; otherwise the section is omitted so unenriched
                wines don't show an empty placeholder. */}
            {row.drink_window_end != null && (
              <DrinkWindowSection row={row} />
            )}

            {errorMsg && (
              <div
                role="alert"
                className="mt-md rounded-sm border border-danger/30 bg-danger-soft px-md py-sm text-[13px] text-danger"
              >
                {errorMsg}
              </div>
            )}

            {/* Quick actions */}
            <section aria-label="Actions" className="mt-md flex flex-col gap-sm">
              {canPour && (
                <div className="flex gap-xs">
                  <button
                    type="button"
                    disabled={busy || outOfStock}
                    onClick={() => row.glass_pour_ml && doPour(row.glass_pour_ml)}
                    className={cn(
                      "h-[56px] flex-1 rounded-sm bg-accent text-[15px] font-medium text-white transition-colors",
                      "hover:bg-accent-hover disabled:opacity-60",
                    )}
                  >
                    {outOfStock
                      ? "Out of stock"
                      : `Pour ${(row.glass_pour_ml! / ML_PER_OZ).toFixed(1)} oz`}
                  </button>
                  {row.pour_size_mode === "picker" && pickerItem && (
                    <button
                      type="button"
                      onClick={() => setPickerOpen(true)}
                      disabled={busy || outOfStock}
                      aria-label="Pick a custom pour size"
                      className="flex h-[56px] w-[56px] items-center justify-center rounded-sm border border-border bg-white text-ink-muted hover:bg-surface-muted disabled:opacity-60"
                    >
                      <ChevronDown className="h-5 w-5" strokeWidth={2} aria-hidden />
                    </button>
                  )}
                </div>
              )}

              {canManage && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setPendingDirection(row.is_eightysixed ? "restored" : "eightysixed")
                  }
                  className={cn(
                    "flex h-[48px] items-center justify-center gap-xs rounded-sm border text-[14px] font-medium transition-colors disabled:opacity-60",
                    row.is_eightysixed
                      ? "border-accent bg-accent text-white hover:bg-accent-hover"
                      : "border-border-strong bg-white text-ink hover:bg-surface-muted",
                  )}
                >
                  <PowerOff className="h-4 w-4" strokeWidth={2} aria-hidden />
                  {row.is_eightysixed ? "Restore" : "86 this wine"}
                </button>
              )}

              {/* Edit metadata — placeholder for v1.5 admin flow. Hidden
                  on staff role. */}
              {canManage && (
                <button
                  type="button"
                  disabled
                  title="Wine editor coming soon"
                  className="flex h-[40px] cursor-not-allowed items-center justify-center gap-xs rounded-sm border border-border bg-surface-muted text-[13px] font-medium text-ink-subtle"
                >
                  <Edit3 className="h-4 w-4" strokeWidth={2} aria-hidden />
                  Edit metadata
                </button>
              )}

              {!canPour && !canManage && (
                <div className="rounded-sm border border-border bg-surface-muted px-md py-sm text-center text-[12px] text-ink-muted">
                  <Wine className="mx-auto mb-2xs h-4 w-4" strokeWidth={1.5} aria-hidden />
                  No actions available for your role.
                </div>
              )}
            </section>

            {row.is_eightysixed && row.eightysixed_at && (
              <p className="mt-md text-center text-[11px] text-ink-subtle">
                86&apos;d {new Date(row.eightysixed_at).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>

      <PourPickerModal
        item={pickerOpen ? pickerItem : null}
        onCancel={() => setPickerOpen(false)}
        onConfirm={(ml) => {
          setPickerOpen(false);
          void doPour(ml);
        }}
      />

      <NoteModal
        open={pendingDirection !== null}
        wineName={`${row.producer} ${row.name}${row.vintage ? ` ${row.vintage}` : ""}`}
        direction={pendingDirection ?? "eightysixed"}
        onCancel={() => setPendingDirection(null)}
        onConfirm={onConfirm86}
      />
    </>
  );
}

/**
 * BND-039 — DrinkWindowSection. Renders the timeline + critic citation +
 * source-note footer between Stock and Actions in the wine-detail drawer.
 *
 * Background tints amber when status is drink_now or past_peak so a
 * sommelier scanning a list of drawers spots urgency immediately.
 *
 * Citation card shows: source (Vinous, Claude AI, etc.), score (when
 * non-null — Phase 1 only fills this from real critics), tasting-note
 * quote (italic, Cormorant). When source is "claude_inference" we show
 * "Estimated · Claude AI" with the date for honest disclosure.
 */
function DrinkWindowSection({ row }: { row: CellarWineRow }) {
  const start = row.drink_window_start;
  const end = row.drink_window_end;
  const yearsLeft = getYearsUntilWindowClose(end);
  const status = getDrinkWindowStatus(start, end);
  const isUrgent = status === "drink_now" || status === "past_peak";
  const statusLabel = formatStatusLabel(status, yearsLeft);

  return (
    <section
      aria-label="Drink window"
      className={cn(
        "mt-md rounded-md p-md",
        isUrgent
          ? "border border-warning/30 bg-warning-soft"
          : "border border-border bg-white",
      )}
      style={isUrgent ? { borderLeft: "3px solid var(--color-warning)" } : undefined}
    >
      <div className="mb-sm flex items-center justify-between">
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-[0.08em]",
            isUrgent ? "text-warning" : "text-ink-subtle",
          )}
        >
          Drink window
        </span>
        <span
          className={cn(
            "rounded-full px-sm py-2xs text-[11px] font-medium",
            isUrgent
              ? "bg-warning text-white"
              : status === "hold"
                ? "bg-bg-tertiary text-ink-muted"
                : "bg-success-soft text-success",
          )}
        >
          {statusLabel}
        </span>
      </div>

      <DrinkWindowTimeline start={start} end={end} size="full" />

      {(row.review_excerpt || row.rating_source) && (
        <div className="mt-md rounded-sm bg-white/60 p-sm" style={{ borderLeft: "2px solid var(--color-accent)" }}>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
            {formatRatingSourceLabel(row.rating_source)}
          </div>
          {row.rating != null && (
            <div className="mt-2xs">
              <span className="font-mono text-[16px] font-medium text-accent">{row.rating}</span>
              <span className="ml-xs text-[12px] text-ink-muted">points</span>
            </div>
          )}
          {row.review_excerpt && (
            <p className="mt-2xs font-serif text-[13px] italic text-ink leading-snug">
              &ldquo;{row.review_excerpt}&rdquo;
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * BND-040 — PricingSection. Renders bottle list / glass list pricing
 * cards with current ratio + target deviation, plus a retail benchmark
 * card and the price-band visual.
 *
 * Trust language locked: NO verdict pills in the drawer (per architect
 * review). Numbers + targets only — verdicts live in outlier contexts
 * where flagging is the whole point.
 */
function PricingSection({ row }: { row: CellarWineRow }) {
  const targetMarkup = resolveMarkupTarget(
    row.pricing_target_markup_ratio,
    row.restaurant_default_target_markup_ratio,
  );
  const targetPourCost = resolvePourCostTarget(
    row.pricing_target_pour_cost_pct,
    row.restaurant_default_target_pour_cost_pct,
  );
  const markupRatio = getMarkupRatio(row.current_bottle_price, row.retail_median);
  const pourCostPct = getPourCostPct(
    row.current_unit_cost ?? row.retail_median,
    row.size_ml,
    row.glass_pour_ml,
    row.current_glass_price,
  );
  const bottleStatus = getBottleStatus(markupRatio, targetMarkup);
  const glassStatus = getGlassStatus(pourCostPct, targetPourCost);
  const stale = isRetailStale(row.retail_refreshed_at);

  return (
    <section
      aria-label="Pricing"
      className="mt-md rounded-md border border-border bg-white p-md"
    >
      <div className="mb-sm flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Pricing
        </span>
        <span className="text-[11px] text-ink-subtle">
          {row.retail_refreshed_at
            ? stale
              ? "Retail data > 7d old"
              : "Retail data current"
            : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-md">
        <PricingCard
          label="Bottle list"
          price={row.current_bottle_price}
          ratio={markupRatio != null ? `${markupRatio.toFixed(1)}× retail` : null}
          target={`target ${targetMarkup.toFixed(1)}×`}
          status={bottleStatus}
        />
        <PricingCard
          label={
            row.glass_pour_ml
              ? `Glass · ${Math.round(row.glass_pour_ml * 0.0338)} oz`
              : "Glass"
          }
          price={row.current_glass_price}
          ratio={pourCostPct != null ? `${pourCostPct.toFixed(0)}% pour cost` : null}
          target={`target ${Math.round(targetPourCost)}%`}
          status={glassStatus}
        />
      </div>

      {/* Price band visual */}
      {row.current_bottle_price != null && (
        <div className="mt-md">
          <PriceBand
            bottleList={row.current_bottle_price}
            retailReference={row.retail_median}
            targetMarkup={targetMarkup}
            size="full"
          />
        </div>
      )}

      {/* Retail benchmark card */}
      <div
        className="mt-md rounded-sm bg-bg-secondary p-sm"
        style={{ borderLeft: "2px solid var(--color-accent)" }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Market retail · Wine-Searcher
        </div>
        <div className="mt-xs flex items-baseline justify-between text-[12px] text-ink-muted">
          <span>Low / median / high</span>
          <span className="font-mono text-ink">
            ${Math.round(row.retail_min ?? 0)} / ${Math.round(row.retail_median ?? 0)} / $
            {Math.round(row.retail_max ?? 0)}
          </span>
        </div>
        {row.retail_retailer_count != null && (
          <div className="mt-2xs text-[11px] text-ink-subtle">
            {row.retail_retailer_count} retailer
            {row.retail_retailer_count === 1 ? "" : "s"}
            {row.retail_refreshed_at && (
              <span className="ml-xs">
                · refreshed {new Date(row.retail_refreshed_at).toLocaleDateString()}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Local benchmark — Layer B preserved hook (honest empty state per
          BND-040 plan §Layer B). No CTA, no viral mechanic. */}
      <div
        className="mt-sm rounded-sm bg-bg-secondary p-sm"
        style={{ borderLeft: "2px solid var(--color-border-strong)" }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Local benchmark
        </div>
        <p className="mt-2xs text-[12px] italic text-ink-muted">
          Local benchmark unavailable — using national retail comps. Available
          when 10+ restaurants in your region opt in.
        </p>
      </div>

      {/* Status hint — only when we have a status (not unknown). Trust
          language: never use prescriptive verbs like "you should". */}
      {(bottleStatus !== "unknown" || glassStatus !== "unknown") && (
        <div className="mt-sm text-[11px] text-ink-tertiary">
          {bottleStatus !== "unknown" && (
            <span>
              Bottle: <span className="text-ink-muted">{formatPricingStatusLabel(bottleStatus)}</span>
            </span>
          )}
          {bottleStatus !== "unknown" && glassStatus !== "unknown" && (
            <span className="mx-xs text-ink-subtle">·</span>
          )}
          {glassStatus !== "unknown" && (
            <span>
              Glass: <span className="text-ink-muted">{formatPricingStatusLabel(glassStatus)}</span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function PricingCard({
  label,
  price,
  ratio,
  target,
  status,
}: {
  label: string;
  price: number | null;
  ratio: string | null;
  target: string;
  status: ReturnType<typeof getBottleStatus>;
}) {
  const ratioClass =
    status === "tight" || status === "outlier"
      ? "text-warning"
      : status === "premium"
        ? "text-success"
        : "text-ink-muted";
  return (
    <div className="rounded-sm bg-bg-secondary p-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
        {label}
      </div>
      <div className="mt-xs font-mono text-[20px] font-medium text-ink">
        {price != null ? `$${Math.round(price)}` : "—"}
      </div>
      {ratio && (
        <div className={`mt-2xs font-mono text-[12px] ${ratioClass}`}>{ratio}</div>
      )}
      <div className="mt-2xs text-[11px] text-ink-subtle">{target}</div>
    </div>
  );
}

function formatRatingSourceLabel(source: string | null): string {
  switch (source) {
    case "rule_engine":
      return "Estimated · Rule engine";
    case "claude_inference":
      return "Estimated · Claude AI";
    case "vinous":
      return "Vinous";
    case "parker":
      return "Wine Advocate (Parker)";
    case "js":
      return "James Suckling";
    case "wine_spectator":
      return "Wine Spectator";
    case "decanter":
      return "Decanter";
    case "aggregate":
      return "Multiple critics";
    default:
      return "—";
  }
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div>
      <div
        className={cn(
          "font-mono text-[18px] text-ink",
          tone === "warn" && "text-warning",
          tone === "ok" && "text-success",
        )}
      >
        {value}
      </div>
      <div className="mt-2xs text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
        {label}
      </div>
    </div>
  );
}
