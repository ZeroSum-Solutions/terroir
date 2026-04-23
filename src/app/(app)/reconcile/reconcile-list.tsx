"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ReconcileItem } from "./page";

const ML_PER_OZ = 29.5735;
const FRACTIONS: Array<{ label: string; value: number }> = [
  { label: "Empty", value: 0 },
  { label: "¼", value: 0.25 },
  { label: "½", value: 0.5 },
  { label: "¾", value: 0.75 },
  { label: "Full", value: 1 },
];

type PendingChange = { newRemainingMl: number; note?: string };

export function ReconcileList({
  initialItems,
}: {
  initialItems: ReconcileItem[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Record<string, PendingChange>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const changedCount = Object.keys(pending).length;

  const onSaveAll = async () => {
    if (changedCount === 0) return;
    setError(null);
    setSaving(true);
    const entries = Object.entries(pending).map(([wine_id, p]) => ({
      wine_id,
      new_remaining_ml: p.newRemainingMl,
      note: p.note,
    }));
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string; code?: string }
          | null;
        throw new Error(payload?.error ?? `Failed (${res.status}).`);
      }
      setPending({});
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  if (initialItems.length === 0) {
    return (
      <div className="rounded-md border border-border bg-white px-md py-lg text-center text-[13px] text-ink-muted">
        No open bottles to reconcile. Open one by pouring a glass.
      </div>
    );
  }

  return (
    <div className="pb-[120px]">
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
            onChange={(change) =>
              setPending((prev) => ({ ...prev, [item.wine_id]: change }))
            }
          />
        ))}
      </ul>

      {/*
        Sticky save bar on mobile (sits above the fixed bottom nav at
        72px). On desktop the page has room, so it drops inline below
        the list with `md:static`.
      */}
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
            ? "Saving…"
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
}: {
  item: ReconcileItem;
  pending: PendingChange | null;
  onChange: (c: PendingChange) => void;
}) {
  const currentMl = pending?.newRemainingMl ?? item.open_remaining_ml;
  const currentOz = (currentMl / ML_PER_OZ).toFixed(1);
  const glassesLeft = useMemo(
    () => Math.floor(item.open_remaining_ml / item.glass_pour_ml),
    [item.open_remaining_ml, item.glass_pour_ml],
  );

  return (
    <li className="rounded-md border border-border bg-white p-md">
      <div className="mb-sm">
        <div className="font-serif text-[15px] text-ink">
          {item.producer} {item.name}
          {item.vintage !== null && (
            <span className="ml-xs font-mono text-[12px] text-ink-muted">
              {item.vintage}
            </span>
          )}
        </div>
        <div className="mt-2xs text-[12px] text-ink-muted">
          System says ~{item.open_remaining_ml} ml (~{glassesLeft} glass
          {glassesLeft === 1 ? "" : "es"})
        </div>
      </div>

      <div className="mb-sm grid grid-cols-5 gap-xs">
        {FRACTIONS.map((f) => {
          const ml = Math.round(item.size_ml * f.value);
          const isActive = currentMl === ml;
          return (
            <button
              key={f.label}
              type="button"
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

      <details className="mt-sm">
        <summary className="cursor-pointer text-[12px] text-accent">
          Exact ml / oz
        </summary>
        <div className="mt-xs flex flex-wrap items-center gap-sm text-[12px] text-ink-muted">
          <label className="flex items-center gap-xs">
            ml:
            <input
              type="number"
              min={0}
              max={item.size_ml}
              value={currentMl}
              onChange={(e) =>
                onChange({
                  newRemainingMl: Math.max(
                    0,
                    Math.min(item.size_ml, Number(e.target.value) || 0),
                  ),
                  note: pending?.note,
                })
              }
              className="h-[32px] w-[80px] rounded-sm border border-border bg-white px-sm text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
            />
          </label>
          <span>(≈ {currentOz} oz)</span>
          <label className="flex w-full items-center gap-xs sm:w-auto sm:flex-1">
            Note:
            <input
              type="text"
              maxLength={500}
              value={pending?.note ?? ""}
              onChange={(e) =>
                onChange({
                  newRemainingMl: currentMl,
                  note: e.target.value,
                })
              }
              placeholder="spill / miscount / etc."
              className="h-[32px] flex-1 rounded-sm border border-border bg-white px-sm text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
            />
          </label>
        </div>
      </details>
    </li>
  );
}
