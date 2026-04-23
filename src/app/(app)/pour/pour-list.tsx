"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { PourItem } from "./page";
import { PourPickerModal } from "./pour-picker-modal";

const ML_PER_OZ = 29.5735;

export function PourList({
  initialItems,
}: {
  initialItems: PourItem[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [pickerFor, setPickerFor] = useState<PourItem | null>(null);
  const [lastPour, setLastPour] = useState<
    | {
        itemId: string;
        wineId: string;
        ml: number;
        wineName: string;
      }
    | null
  >(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const doPour = useCallback(
    async (item: PourItem, ml: number) => {
      setErrorMsg(null);
      // Snapshot the row before optimistic update so we can revert just
      // this row on failure (don't clobber concurrent-successful rows).
      const prev = items.find((it) => it.wine_id === item.wine_id);
      if (!prev) return;

      // Optimistic: subtract ml from local state. If there's no open
      // bottle (remaining === null), simulate opening: remaining becomes
      // size_ml - ml, sealed_count drops by 1.
      setItems((rows) =>
        rows.map((it) => {
          if (it.wine_id !== item.wine_id) return it;
          if (it.open_remaining_ml === null) {
            return {
              ...it,
              open_remaining_ml: Math.max(0, it.size_ml - ml),
              sealed_count: Math.max(0, it.sealed_count - 1),
              opened_at: new Date().toISOString(),
            };
          }
          return {
            ...it,
            open_remaining_ml: Math.max(0, it.open_remaining_ml - ml),
          };
        }),
      );

      try {
        const res = await fetch("/api/pour", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wine_id: item.wine_id, ml, kind: "pour" }),
        });

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: string; code?: string }
            | null;
          throw new Error(payload?.error ?? `Request failed (${res.status}).`);
        }

        setLastPour({
          itemId: item.wine_list_item_id,
          wineId: item.wine_id,
          ml,
          wineName: `${item.producer} ${item.name}`,
        });
        // Auto-hide the undo banner after 6s.
        const timerWineId = item.wine_id;
        setTimeout(() => {
          setLastPour((curr) =>
            curr && curr.wineId === timerWineId ? null : curr,
          );
        }, 6000);

        // Refresh the server component to reconcile with real numbers.
        startTransition(() => router.refresh());
      } catch (err) {
        // Surgical revert: restore just this row.
        setItems((rows) =>
          rows.map((it) => (it.wine_id === item.wine_id ? prev : it)),
        );
        setErrorMsg(err instanceof Error ? err.message : "Pour failed.");
      }
    },
    [items, router],
  );

  const onUndo = useCallback(async () => {
    if (!lastPour) return;
    const restore = lastPour;
    setLastPour(null);

    // Undo = compensating reconcile that adds ml back. Ledger stays
    // append-only. We target current remaining + the ml that was
    // subtracted; the RPC is idempotent on this shape.
    const item = items.find((i) => i.wine_id === restore.wineId);
    if (!item) return;
    const currentRemaining =
      item.open_remaining_ml ?? item.size_ml; // if we just opened it
    const target = Math.min(item.size_ml, currentRemaining + restore.ml);

    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              wine_id: item.wine_id,
              new_remaining_ml: target,
              note: "undo: last pour",
            },
          ],
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Undo failed (${res.status}).`);
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Undo failed.");
    }
  }, [items, lastPour, router]);

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-border bg-white px-md py-lg text-center text-[13px] text-ink-muted">
        No wines configured for pour tracking yet. Set a pour size on a
        wine-list-item to begin.
      </div>
    );
  }

  return (
    <div>
      {errorMsg && (
        <div
          role="alert"
          className="mb-md rounded-sm border border-danger/30 bg-danger-soft px-md py-sm text-[13px] text-danger"
        >
          {errorMsg}
        </div>
      )}

      <ul className="grid grid-cols-1 gap-md md:grid-cols-2">
        {items.map((item) => (
          <PourCard
            key={item.wine_list_item_id}
            item={item}
            onTap={() => void doPour(item, item.glass_pour_ml)}
            onPicker={() => setPickerFor(item)}
          />
        ))}
      </ul>

      {lastPour && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-[80px] left-1/2 z-40 w-[calc(100%-32px)] max-w-[480px] -translate-x-1/2 rounded-md border border-ink bg-ink px-md py-sm text-white shadow-lg md:bottom-lg"
        >
          <div className="flex items-center justify-between gap-md">
            <span className="truncate text-[13px]">
              Poured {(lastPour.ml / ML_PER_OZ).toFixed(1)} oz of{" "}
              {lastPour.wineName}
            </span>
            <button
              type="button"
              onClick={onUndo}
              className="shrink-0 rounded-sm bg-white/15 px-sm py-xs text-[12px] font-medium hover:bg-white/25"
            >
              Undo
            </button>
          </div>
        </div>
      )}

      <PourPickerModal
        item={pickerFor}
        onCancel={() => setPickerFor(null)}
        onConfirm={(ml) => {
          const target = pickerFor;
          setPickerFor(null);
          if (target) void doPour(target, ml);
        }}
      />
    </div>
  );
}

function PourCard({
  item,
  onTap,
  onPicker,
}: {
  item: PourItem;
  onTap: () => void;
  onPicker: () => void;
}) {
  // Total available across the open bottle + sealed inventory.
  const totalAvailableMl =
    (item.open_remaining_ml ?? 0) + item.sealed_count * item.size_ml;
  const glassesLeft = Math.floor(totalAvailableMl / item.glass_pour_ml);
  const outOfStock = totalAvailableMl < item.glass_pour_ml;
  // Fill bar reflects CURRENT open bottle (0 → 100%). If no open
  // bottle, we show the bar "full" as a preview of what happens next tap.
  const pctRemaining =
    item.open_remaining_ml === null
      ? 100
      : Math.max(
          0,
          Math.min(100, Math.round((item.open_remaining_ml / item.size_ml) * 100)),
        );

  return (
    <li className="rounded-md border border-border bg-white p-md">
      <div className="mb-sm">
        <div className="font-serif text-[16px] text-ink">
          {item.producer} {item.name}
          {item.vintage !== null && (
            <span className="ml-xs font-mono text-[12px] text-ink-muted">
              {item.vintage}
            </span>
          )}
        </div>
        <div className="mt-2xs text-[12px] text-ink-muted">
          {outOfStock
            ? "Out of stock"
            : `~${glassesLeft} glass${glassesLeft === 1 ? "" : "es"} left`}
        </div>
      </div>

      <div
        className="mb-md h-[4px] w-full overflow-hidden rounded-full bg-surface-muted"
        aria-hidden="true"
      >
        <div
          className={cn(
            "h-full transition-all",
            pctRemaining > 25
              ? "bg-success"
              : pctRemaining > 10
                ? "bg-warning"
                : "bg-danger",
          )}
          style={{ width: `${pctRemaining}%` }}
        />
      </div>

      <div className="flex items-stretch gap-xs">
        {outOfStock ? (
          <a
            href="/availability"
            className="flex h-[56px] flex-1 items-center justify-center rounded-sm border border-border bg-surface-muted px-md text-center text-[13px] font-medium text-ink-muted"
          >
            86 or restock →
          </a>
        ) : (
          <>
            <button
              type="button"
              onClick={onTap}
              className="h-[56px] flex-1 rounded-sm bg-accent text-[15px] font-medium text-white hover:bg-accent-hover"
            >
              Pour {(item.glass_pour_ml / ML_PER_OZ).toFixed(1)} oz
            </button>
            {item.pour_size_mode === "picker" && (
              <button
                type="button"
                onClick={onPicker}
                aria-label={`Pick pour size for ${item.producer} ${item.name}`}
                className="flex h-[56px] w-[56px] items-center justify-center rounded-sm border border-border bg-white text-[18px] font-semibold text-ink-muted hover:bg-surface-muted"
              >
                ⌄
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
