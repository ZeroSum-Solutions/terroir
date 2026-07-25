"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
  readApiErrorCode,
  shouldRetainIdempotencyKey,
} from "@/lib/api/idempotency-client";
import { cn } from "@/lib/utils";
import { ML_PER_OZ } from "@/lib/units";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";

type ReconcileItem = OpenBottleRow;

const FRACTIONS: Array<{ label: string; value: number }> = [
  { label: "Empty", value: 0 },
  { label: "Quarter", value: 0.25 },
  { label: "Half", value: 0.5 },
  { label: "Three Quarter", value: 0.75 },
  { label: "Full", value: 1 },
];

type PendingChange = { newRemainingMl: number; note?: string };

const reconcileCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:reconcile"),
});

export function ReconcileList({
  initialItems,
  varianceThresholdOz = 1.0,
}: {
  initialItems: ReconcileItem[];
  varianceThresholdOz?: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Record<string, PendingChange>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const savingRef = useRef(false);

  const changedCount = Object.keys(pending).length;

  const onSaveAll = async () => {
    if (changedCount === 0 || savingRef.current) return;
    savingRef.current = true;
    setError(null);
    setSaving(true);
    const entries = Object.entries(pending).map(([wine_id, p]) => ({
      wine_id,
      new_remaining_ml: p.newRemainingMl,
      note: p.note,
    }));
    let shouldRefreshAfterFailure = true;
    try {
      const { response, data } =
        await reconcileCommands.json<unknown>({
          slot: "save-all",
          url: "/api/reconcile",
          method: "POST",
          json: { entries },
        });
      if (!response.ok) {
        shouldRefreshAfterFailure = shouldRetainIdempotencyKey(
          response.status,
          readApiErrorCode(data),
        );
        throw new Error(
          readApiError(
            data,
            `Failed (${response.status}).`,
          ).message,
        );
      }
      setPending((current) => {
        const remaining = { ...current };
        for (const entry of entries) {
          const latest = current[entry.wine_id];
          if (
            latest?.newRemainingMl === entry.new_remaining_ml &&
            latest.note === entry.note
          ) {
            delete remaining[entry.wine_id];
          }
        }
        return remaining;
      });
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      if (shouldRefreshAfterFailure) {
        startTransition(() => router.refresh());
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const updatePending = (
    wineId: string,
    change: PendingChange,
  ) => {
    if (savingRef.current) return;
    setPending((prev) => ({ ...prev, [wineId]: change }));
  };

  if (initialItems.length === 0) {
    return (
      <div className="rounded-md border border-border bg-white px-md py-lg text-center text-[13px] text-ink-muted">
        No open bottles to reconcile. Open one by pouring a glass.
      </div>
    );
  }

  return (
    <div className="pb-[120px]" aria-busy={saving}>
      {error && (
        <div
          role="alert"
          className="mb-md rounded-sm border border-danger/30 bg-danger-soft px-md py-sm text-[13px] text-danger"
        >
          {error}
        </div>
      )}

      <ul className="flex flex-col gap-md">
        {initialItems.map((item) => (
          <ReconcileRow
            key={item.wine_id}
            item={item}
            pending={pending[item.wine_id] ?? null}
            varianceThresholdOz={varianceThresholdOz}
            disabled={saving}
            onChange={(change) => updatePending(item.wine_id, change)}
          />
        ))}
      </ul>

      <div className="fixed bottom-[72px] left-0 right-0 z-30 border-t border-border bg-white px-lg py-sm md:static md:mt-lg md:border-0 md:px-0 md:py-0">
        <button
          type="button"
          onClick={onSaveAll}
          disabled={changedCount === 0 || saving}
          className={cn(
            "h-[48px] w-full rounded-sm font-medium transition-colors",
            changedCount > 0 && !saving
              ? "bg-accent text-white hover:bg-accent-hover"
              : "bg-surface-muted text-ink-subtle",
          )}
        >
          {saving
            ? "Saving..."
            : changedCount > 0
              ? `Save ${changedCount} change${changedCount === 1 ? "" : "s"}`
              : "No changes yet"}
        </button>
      </div>
    </div>
  );
}

function ReconcileRow({
  item,
  pending,
  onChange,
  varianceThresholdOz,
  disabled,
}: {
  item: ReconcileItem;
  pending: PendingChange | null;
  onChange: (c: PendingChange) => void;
  varianceThresholdOz: number;
  disabled: boolean;
}) {
  const currentMl = pending?.newRemainingMl ?? item.open_remaining_ml;
  const currentOz = currentMl / ML_PER_OZ;
  const trackedOz = item.open_remaining_ml / ML_PER_OZ;
  const glassesLeft = useMemo(
    () => Math.floor(item.open_remaining_ml / item.glass_pour_ml),
    [item.open_remaining_ml, item.glass_pour_ml],
  );

  const expectedMl = item.open_remaining_ml;
  const actualMl = pending?.newRemainingMl ?? expectedMl;
  const varianceMl = actualMl - expectedMl;
  const varianceOz = varianceMl / ML_PER_OZ;
  const hasVariance = pending !== null && pending.newRemainingMl !== item.open_remaining_ml;
  const isVarianceFlagged = hasVariance && Math.abs(varianceOz) > varianceThresholdOz;

  return (
    <li
      className={`rounded-md border p-md ${
        isVarianceFlagged
          ? "border-warning/50 bg-warning-soft/20"
          : "border-border bg-white"
      }`}
    >
      <div className="mb-sm">
        <div className="flex items-start justify-between gap-sm">
          <div className="min-w-0">
            <div className="font-serif text-[15px] text-ink leading-snug">
              {item.producer} {item.name}
              {item.vintage !== null && (
                <span className="ml-xs font-mono text-[12px] text-ink-muted">
                  {item.vintage}
                </span>
              )}
            </div>
            <div className="mt-2xs flex flex-wrap items-center gap-xs text-[12px] text-ink-muted">
              <span className="rounded-pill bg-surface-muted px-sm py-2xs font-mono">
                {formatBottleSize(item.size_ml)}
              </span>
              {item.opened_at && (
                <span className="tabular-nums">
                  Opened {formatOpenedAt(item.opened_at)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mb-sm rounded-sm bg-surface-muted px-sm py-sm">
        <div className="flex flex-wrap items-baseline gap-sm">
          <span className="text-[12px] text-ink-muted">Tracked:</span>
          <span className="font-mono text-[15px] font-semibold text-ink tabular-nums">
            {trackedOz.toFixed(1)} oz
          </span>
          <span className="text-[12px] text-ink-subtle tabular-nums">
            ({item.open_remaining_ml} ml ~{glassesLeft} glass
            {glassesLeft === 1 ? "" : "es"})
          </span>
        </div>
      </div>

      <div className="mb-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex items-center gap-xs text-[13px] text-ink-muted">
            <span>Actual:</span>
            <input
              type="number"
              disabled={disabled}
              min={0}
              max={item.size_ml}
              value={currentMl}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  onChange({
                    newRemainingMl: 0,
                    note: pending?.note,
                  });
                  return;
                }
                const val = Number(raw);
                if (isNaN(val) || val < 0) {
                  return;
                }
                onChange({
                  newRemainingMl: Math.min(item.size_ml, val),
                  note: pending?.note,
                });
              }}
              className="h-[40px] w-[96px] rounded-sm border border-border bg-white px-sm text-[14px] font-mono tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
              aria-label="Actual remaining volume in ml"
            />
          </label>
          <span className="text-[13px] text-ink-subtle tabular-nums">
            = {currentOz.toFixed(1)} oz
          </span>
        </div>
        {hasVariance && (
          <div
            className={`mt-xs inline-flex items-center gap-xs rounded-pill px-sm py-2xs text-[12px] font-semibold ${
              Math.abs(varianceOz) > varianceThresholdOz
                ? "bg-warning-soft text-warning"
                : "bg-surface-muted text-ink-subtle"
            }`}
          >
            {varianceOz > 0 ? "↑" : varianceOz < 0 ? "↓" : "="}{" "}
            {Math.abs(varianceOz).toFixed(1)} oz{" "}
            {varianceOz > 0 ? "less than tracked" : varianceOz < 0 ? "more than tracked" : "no change"}
          </div>
        )}
      </div>

      <div className="mb-sm grid grid-cols-5 gap-xs">
        {FRACTIONS.map((f) => {
          const ml = Math.round(item.size_ml * f.value);
          const isActive = currentMl === ml;
          return (
            <button
              key={f.label}
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange({
                  newRemainingMl: ml,
                  note: pending?.note,
                })
              }
              className={cn(
                "h-[44px] rounded-sm border text-[12px] font-medium transition-colors",
                isActive
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-white text-ink hover:bg-surface-muted",
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-sm">
        <label className="flex w-full items-center gap-xs sm:w-auto sm:flex-1">
          <span className="text-[12px] text-ink-muted whitespace-nowrap">
            Note:
          </span>
          <input
            type="text"
            disabled={disabled}
            maxLength={500}
            value={pending?.note ?? ""}
            onChange={(e) =>
              onChange({
                newRemainingMl: currentMl,
                note: e.target.value,
              })
            }
            placeholder="spill, miscount, etc."
            className="h-[32px] flex-1 rounded-sm border border-border bg-white px-sm text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
          />
        </label>
      </div>
    </li>
  );
}

function formatBottleSize(sizeMl: number): string {
  if (sizeMl === 750) return "750ml";
  if (sizeMl === 375) return "Half (375ml)";
  if (sizeMl === 1500) return "Magnum (1.5L)";
  if (sizeMl === 3000) return "Double Magnum (3L)";
  if (sizeMl === 6000) return "Imperial (6L)";
  if (sizeMl >= 1000) return `${(sizeMl / 1000).toFixed(1)}L`;
  return `${sizeMl}ml`;
}

function formatOpenedAt(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
