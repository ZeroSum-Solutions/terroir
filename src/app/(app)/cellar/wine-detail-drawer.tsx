"use client";

import { useRef, useState, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, Wine, PowerOff, Edit3, ChevronDown } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { ML_PER_OZ } from "@/lib/units";
import { cn } from "@/lib/utils";
import { NoteModal } from "./note-modal";
import { PourPickerModal } from "./pour-picker-modal";
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
