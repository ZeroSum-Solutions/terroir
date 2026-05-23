"use client";

import { useRef, useState, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, Wine, PowerOff, Edit3, ChevronDown, Sparkles, Loader2, Undo2 } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { useToast } from "@/lib/toast";
import { ML_PER_OZ } from "@/lib/units";
import { cn } from "@/lib/utils";
import { NoteModal } from "./note-modal";
import { PourPickerModal } from "./pour-picker-modal";
import { PricingTargetOverride } from "./pricing-target-override";
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
  const toast = useToast();

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState<string | null>(null);

  // BND-119: track last pour for undo.
  const [lastPour, setLastPour] = useState<{ ml: number } | null>(null);

  const [pendingDirection, setPendingDirection] = useState<
    "eightysixed" | "restored" | null
  >(null);

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: onClose,
    enabled: row !== null,
  });

  const doPour = useCallback(
    async (ml: number) => {
      if (!row || !row.glass_pour_ml) return;
      setErrorMsg(null);
      setBusy(true);
      setLastPour(null);

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
        toast.success("Glass poured");
        setLastPour({ ml });
        startTransition(() => router.refresh());
      } catch (err) {
        toast.error("Pour failed");
        setErrorMsg(err instanceof Error ? err.message : "Pour failed.");
      } finally {
        setBusy(false);
      }
    },
    [row, router],
  );

  // BND-119: undo the most recent pour.
  const doUndo = useCallback(
    async () => {
      if (!row || !lastPour) return;
      setErrorMsg(null);
      setBusy(true);
      try {
        const res = await fetch("/api/pour/undo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wine_id: row.wine_id }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(payload?.error ?? `Undo failed (${res.status}).`);
        }
        toast.success("Pour undone");
        setLastPour(null);
        startTransition(() => router.refresh());
      } catch (err) {
        toast.error("Undo failed");
        setErrorMsg(err instanceof Error ? err.message : "Undo failed.");
      } finally {
        setBusy(false);
      }
    },
    [row, lastPour, router],
  );

  const doEnrich = useCallback(
    async () => {
      if (!row) return;
      setEnriching(true);
      setEnrichMsg(null);
      setErrorMsg(null);
      try {
        const res = await fetch(`/api/wines/${row.wine_id}/enrich`, {
          method: "POST",
        });
        const payload = (await res.json().catch(() => null)) as
          | { source?: string | null; message?: string; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(payload?.error ?? `Enrichment failed (${res.status}).`);
        }
        if (payload?.source == null) {
          setEnrichMsg(payload?.message ?? "Could not enrich this wine.");
        } else {
          setEnrichMsg(`Enriched via ${payload.source === "claude_inference" ? "Claude AI" : "rule engine"}.`);
          startTransition(() => router.refresh());
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Enrichment failed.");
      } finally {
        setEnriching(false);
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
      toast.success(direction === "eightysixed" ? "Marked as 86'd" : "Restored");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error("Toggle failed");
      setErrorMsg(err instanceof Error ? err.message : "Toggle failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!row) return null;

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

  const canPour =
    row.glass_pour_ml &&
    row.glass_pour_ml > 0 &&
    !row.is_eightysixed;
  const outOfStock = canPour && totalMl !== null && totalMl < row.glass_pour_ml!;

  return (
    <>
      {row && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-lg bg-surface md:absolute md:inset-y-0 md:right-0 md:left-auto md:w-[420px] md:rounded-none md:border-l md:border-border"
          style={{ maxHeight: "calc(100dvh - 3.5rem)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-md py-sm">
            <h2 id={headingId} className="text-[15px] font-semibold text-ink leading-snug">
              <span className="font-serif">{row.producer}</span>{" "}
              <span className="font-medium">{row.name}</span>
              {row.vintage != null && (
                <span className="font-normal text-ink-muted"> {row.vintage}</span>
              )}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>

          {/* Body */}
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

            {row.retail_median != null && (
              <PricingSection row={row} canManage={canManage} />
            )}

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

              {/* BND-119: Undo last pour */}
              {lastPour && canPour && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={doUndo}
                  className="flex h-[40px] items-center justify-center gap-xs rounded-sm border border-warning/40 bg-warning-soft text-[13px] font-medium text-warning-text transition-colors hover:bg-warning-soft/70 disabled:opacity-60"
                >
                  <Undo2 className="h-4 w-4" strokeWidth={2} aria-hidden />
                  Undo last pour ({(lastPour.ml / ML_PER_OZ).toFixed(1)} oz)
                </button>
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

              {canManage && (
                <div className="flex flex-col gap-xs">
                  <button
                    type="button"
                    disabled={enriching}
                    onClick={doEnrich}
                    className={cn(
                      "flex h-[40px] items-center justify-center gap-xs rounded-sm border text-[13px] font-medium transition-colors disabled:opacity-60",
                      enrichMsg
                        ? "border-success/30 bg-success-soft text-success"
                        : "border-border-strong bg-white text-ink hover:bg-surface-muted",
                    )}
                  >
                    {enriching ? (
                      <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
                    ) : enrichMsg ? (
                      <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />
                    ) : (
                      <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />
                    )}
                    {enriching ? "Enriching..." : enrichMsg ? "Enriched!" : "Re-enrich"}
                  </button>
                  {enrichMsg && (
                    <p className="text-[11px] text-ink-muted">{enrichMsg}</p>
                  )}
                </div>
              )}

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
          </div>
        </div>
      )}

      {/* Pour picker modal */}
      {pickerOpen && pickerItem && (
        <PourPickerModal
          item={pickerItem}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(ml) => {
            setPickerOpen(false);
            doPour(ml);
          }}
        />
      )}

      {/* 86/restore note modal */}
      {pendingDirection && row && (
        <NoteModal
          title={pendingDirection === "eightysixed" ? "Mark as 86'd" : "Restore"}
          actionLabel={
            pendingDirection === "eightysixed" ? "Mark 86'd" : "Restore"
          }
          onSubmit={(note) => onConfirm86(note)}
          onCancel={() => setPendingDirection(null)}
        />
      )}
    </>
  );
}

/** Tiny stat chip used inside the drawer stock grid. */
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
    <div className="flex flex-col items-center gap-2xs">
      <span className="text-[11px] uppercase tracking-[0.04em] text-ink-muted">
        {label}
      </span>
      <span
        className={cn(
          "text-[14px] font-semibold leading-none",
          tone === "warn" && "text-warning-text",
          tone === "ok" && "text-success",
          !tone && "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * BND-040 — PricingSection. Renders the pricing panel for wines that
 * have retail price data. Shows glass/bottle prices and their margins
 * relative to the restaurant's pricing targets.
 */
function PricingSection({
  row,
  canManage,
}: {
  row: CellarWineRow;
  canManage: boolean;
}) {
  const glassStatus = getGlassStatus(row as any);
  const bottleStatus = getBottleStatus(row as any);
  const isRetailOld =
    row.retail_median != null &&
    row.retail_scrape_date != null &&
    isRetailStale(row.retail_scrape_date);

  return (
    <section
      aria-label="Pricing"
      className="mt-md rounded-md border border-border bg-white p-md"
    >
      <h3 className="text-[13px] font-semibold text-ink mb-sm">Pricing</h3>

      <div className="space-y-sm">
        {/* Glass pour row */}
        {row.glass_price != null && row.glass_pour_ml && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] font-medium text-ink">
                ${row.glass_price.toFixed(2)}{" "}
                <span className="font-normal text-ink-muted">
                  / {(row.glass_pour_ml / ML_PER_OZ).toFixed(1)} oz glass
                </span>
              </p>
              {glassStatus !== "ok" && glassStatus !== "unknown" && (
                <p className="text-[12px] text-ink-muted">
                  {formatPricingStatusLabel(glassStatus)}
                </p>
              )}
            </div>
            <PriceBand
              status={glassStatus}
              markupRatio={getMarkupRatio(row as any, "glass")}
              pourCostPct={getPourCostPct(row as any, "glass")}
              targetMarkup={resolveMarkupTarget(row as any, "glass")}
              targetPourCost={resolvePourCostTarget(row as any, "glass")}
            />
          </div>
        )}

        {/* Bottle row */}
        {row.bottle_price != null && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] font-medium text-ink">
                ${row.bottle_price.toFixed(2)}{" "}
                <span className="font-normal text-ink-muted">/ bottle</span>
              </p>
              {bottleStatus !== "ok" && bottleStatus !== "unknown" && (
                <p className="text-[12px] text-ink-muted">
                  {formatPricingStatusLabel(bottleStatus)}
                </p>
              )}
            </div>
            <PriceBand
              status={bottleStatus}
              markupRatio={getMarkupRatio(row as any, "bottle")}
              pourCostPct={getPourCostPct(row as any, "bottle")}
              targetMarkup={resolveMarkupTarget(row as any, "bottle")}
              targetPourCost={resolvePourCostTarget(row as any, "bottle")}
            />
          </div>
        )}

        {isRetailOld && (
          <p className="text-[11px] text-ink-subtle">
            Retail data is over 30 days old. May not reflect current pricing.
          </p>
        )}
      </div>

      {canManage && row.bottle_price != null && (
        <div className="mt-md">
          <PricingTargetOverride wineId={row.wine_id} />
        </div>
      )}
    </section>
  );
}

/**
 * BND-039 + BND-071 — DrinkWindowSection. Renders the timeline + status
 * pill + critic citation + start/peak/end year labels for wines that have
 * been enriched with drink-window data.
 */
function DrinkWindowSection({ row }: { row: CellarWineRow }) {
  const status = getDrinkWindowStatus(row.drink_window_start, row.drink_window_end);
  const yearsLeft = getYearsUntilWindowClose(row.drink_window_end);

  // BND-071 — status pill color mapping.
  const pillStyle = (() => {
    switch (status) {
      case "hold":
        return "bg-surface-muted text-ink-muted border-border";
      case "optimal":
        return "bg-success-soft text-success border-success/30";
      case "drink_now":
        return "bg-warning-soft text-warning border-warning/30";
      case "past_peak":
        return "bg-danger-soft text-danger border-danger/30";
      default:
        return "bg-surface-muted text-ink-muted border-border";
    }
  })();

  return (
    <section
      aria-label="Drink window"
      className="mt-md rounded-md border border-border bg-white p-md"
    >
      <h3 className="text-[13px] font-semibold text-ink mb-sm">Drink window</h3>

      {/* BND-071 — start / peak / end year labels above the timeline. */}
      <div className="mb-xs flex items-center justify-between text-[11px] font-mono text-ink-subtle">
        <span>Start {row.drink_window_start}</span>
        {row.peak_year != null && (
          <span className="text-accent font-medium">Peak {row.peak_year}</span>
        )}
        <span>End {row.drink_window_end}</span>
      </div>

      <DrinkWindowTimeline
        start={row.drink_window_start as number}
        end={row.drink_window_end as number}
        peak={row.peak_year as number | undefined}
      />

      <div className="mt-sm flex items-center justify-between text-[12px]">
        {/* BND-071 — status pill replacing plain span. */}
        <span
          className={`inline-flex items-center rounded-full border px-sm py-2xs text-[11px] font-semibold ${pillStyle}`}
        >
          {formatStatusLabel(status, yearsLeft)}
        </span>
        {yearsLeft !== null && (
          <span className="text-ink-subtle">
            {yearsLeft >= 0
              ? `${yearsLeft} year${yearsLeft === 1 ? "" : "s"} left`
              : `${Math.abs(yearsLeft)} year${Math.abs(yearsLeft) === 1 ? "" : "s"} past`}
          </span>
        )}
      </div>

      {row.review_excerpt && (
        <blockquote className="mt-sm border-l-2 border-accent-soft pl-sm text-[12px] text-ink-muted italic leading-relaxed">
          {row.review_excerpt}
          {row.rating && row.rating_source && (
            <cite className="mt-2xs block not-italic font-medium text-ink-subtle">
              {row.rating} pts — {row.rating_source}
            </cite>
          )}
        </blockquote>
      )}
    </section>
  );
}
