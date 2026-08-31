"use client";

import { useRef, useState, useTransition, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X, PowerOff, Edit3, Loader2, Upload } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { useToast } from "@/lib/toast";
import { ML_PER_OZ } from "@/lib/units";
import { cn } from "@/lib/utils";
import { NoteModal } from "./note-modal";
import { EditMetadataModal } from "./edit-metadata-modal";
import { PourPickerModal } from "./pour-picker-modal";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import type { CellarWineRow } from "./types";
import type { PreservationMethod } from "@/lib/partial-bottles/math";
import { PartialBottleCloseout } from "./partial-bottle-closeout";
import { StockAdjustmentForm } from "./stock-adjustment-form";
import { WineDetailIdentity } from "./wine-detail-identity";
import { Stat } from "./stat";
import { PricingSection } from "./pricing-section";
import { DecantTimeSection } from "./decant-time-section";
import { ServingTempSection } from "./serving-temp-section";
import { DrinkWindowSection } from "./drink-window-section";
import { MergeDuplicatesPanel } from "./merge-duplicates-panel";
import { DeleteWinePanel } from "./delete-wine-panel";
import { EnrichControl } from "./enrich-control";
import { PourActionBar } from "./pour-action-bar";
import { useHeroImageActions } from "./use-hero-image-actions";
import { useEightysixToggle } from "./use-eightysix-toggle";
import { useAsyncAction } from "./use-async-action";
import { wineDisplayName } from "@/lib/wine-display-name";

export function WineDetailDrawer({
  row,
  canManage,
  isOwner,
  onClose,
  duplicateRows,
}: {
  row: CellarWineRow | null;
  canManage: boolean;
  isOwner?: boolean;
  onClose: () => void;
  // OPP-1 (EV-1.2) — same-lineage/vintage/format twins of `row`, offered
  // for merge below. Provided by the shell from the page's suspect scan.
  duplicateRows?: CellarWineRow[];
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "wine-detail-heading";
  const [, startTransition] = useTransition();
  const toast = useToast();
  // Shared by the new sibling files below (merge / delete / enrich / hero
  // image / 86-toggle) so they don't each need their own useRouter +
  // useTransition wiring for a single router.refresh() call.
  const refresh = useCallback(
    () => startTransition(() => router.refresh()),
    [startTransition, router],
  );

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const closeDrawer = useCallback(() => {
    setDismissed(true);
    onClose();
  }, [onClose]);

  // BND-119: track last pour for undo.
  const [lastPour, setLastPour] = useState<{ ml: number } | null>(null);

  // OPP-1 (EV-1.2) — merge-duplicate confirmation state (mergeConfirm) now
  // lives inside merge-duplicates-panel.tsx; `busy`/`errorMsg` above stay
  // here because merge/pour/undo/delete/86 share one busy flag and one
  // error banner on purpose — an in-flight mutation on one control
  // disables the others so two conflicting mutations on the same wine
  // can't race.

  // BND-058: delete-confirmation state now lives in delete-wine-panel.tsx.

  // Destructured rather than kept as a `heroImage.*` object: reading the
  // ref off a member expression during render trips react-hooks/refs, which
  // the React Compiler enforces. The original code held this ref as a plain
  // `useRef` binding in this component, and destructuring restores exactly
  // that shape at the JSX call site.
  const {
    uploading: heroImageUploading,
    fileInputRef: heroImageInputRef,
    handleImageUpload: handleHeroImageUpload,
    handleImageDelete: handleHeroImageDelete,
  } = useHeroImageActions({
    wineId: row?.wine_id ?? null,
    setErrorMsg,
    toast,
    refresh,
  });

  const eightysix = useEightysixToggle({
    wineId: row?.wine_id ?? null,
    busy,
    setBusy,
    setErrorMsg,
    toast,
    refresh,
  });

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: closeDrawer,
    enabled: row !== null && !dismissed,
    paused: pickerOpen || eightysix.pendingDirection !== null || editOpen,
  });

  // BND-121: manually open a bottle without recording a pour. Its busy
  // flag has never been shared with any other drawer action, so — unlike
  // merge/pour/undo/delete/86 above — this is a genuine fit for
  // useAsyncAction.
  const [preservationMethod, setPreservationMethod] =
    useState<PreservationMethod>(row?.preservation_method ?? "none");
  const openBottleAction = useAsyncAction();

  const doOpenBottle = useCallback(
    () => {
      if (!row) return Promise.resolve();
      setErrorMsg(null);
      return openBottleAction.run(
        async () => {
          const res = await fetch("/api/open-bottles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              wine_id: row.wine_id,
              preservation_method: preservationMethod,
            }),
          });
          if (!res.ok) {
            const payload = (await res.json().catch(() => null)) as
              | { error?: { message?: string } }
              | null;
            throw new Error(
              payload?.error?.message ?? `Failed to open bottle (${res.status}).`,
            );
          }
          toast.success("Bottle opened");
          refresh();
        },
        {
          fallbackMessage: "Failed to open bottle.",
          onError: (message) => {
            toast.error("Open bottle failed");
            setErrorMsg(message);
          },
        },
      );
    },
    [row, preservationMethod, toast, refresh, openBottleAction],
  );

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
          body: JSON.stringify({
            wine_id: row.wine_id,
            ml,
            kind: "pour",
            preservation_method: preservationMethod,
          }),
        });
        const payload = (await res.json().catch(() => null)) as
          | { error?: string | { message?: string }; warning?: { message?: string } }
          | null;
        if (!res.ok) {
          const message = typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
          throw new Error(message ?? `Request failed (${res.status}).`);
        }
        toast.success("Glass poured");
        if (payload?.warning?.message) {
          setErrorMsg(payload.warning.message);
        }
        setLastPour({ ml });
        startTransition(() => router.refresh());
      } catch (err) {
        toast.error("Pour failed");
        setErrorMsg(err instanceof Error ? err.message : "Pour failed.");
      } finally {
        setBusy(false);
      }
    },
    [row, router, toast, preservationMethod],
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
    [row, lastPour, router, toast],
  );

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

  const canPour = Boolean(
    row.glass_pour_ml &&
    row.glass_pour_ml > 0 &&
    !row.is_eightysixed,
  );
  const outOfStock = Boolean(canPour && totalMl !== null && totalMl < row.glass_pour_ml!);

  return (
    <>
      {row && !dismissed && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          className="fixed inset-x-0 bottom-0 z-[var(--z-dialog)] flex flex-col rounded-t-lg bg-surface md:top-[var(--chrome-header-total)] md:bottom-0 md:right-0 md:left-auto md:w-[420px] md:rounded-none md:border-l md:border-rule"
          style={{ maxHeight: "calc(100dvh - 3.5rem)" }}
        >
          {/* Grab handle — mobile sheet affordance */}
          <div className="flex justify-center pt-xs md:hidden" aria-hidden>
            <div className="h-[5px] w-9 rounded-pill bg-ink/25" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between border-b border-rule px-md py-sm">
            <div className="min-w-0">
              <h2 id={headingId} className="font-serif text-[19px] font-medium text-ink leading-snug">
                {/* BUG-01 — the name is rendered with the producer lifted off
                    its front, because the producer is already the span beside
                    it. See src/lib/wine-display-name.ts: this heading is the
                    "Benoit Ente Benoit Ente, Puligny-Montrachet" Devin
                    photographed. */}
                <span>{row.producer}</span>{" "}
                <span>{wineDisplayName(row.producer, row.name)}</span>
              </h2>
              {row.vintage != null && (
                <p className="mt-2xs font-mono text-[11px] tracking-[0.12em] text-grey">
                  {row.vintage}
                </p>
              )}
              {/* The drawer stays the place to ACT on a bottle (pour, 86,
                  adjust stock); the full page is the place to read about the
                  wine, and carries the reference data the drawer has no room
                  for. */}
              <Link
                href={`/cellar/${row.wine_id}`}
                className="mt-2xs inline-block text-[11px] uppercase tracking-[0.12em] text-accent hover:underline"
              >
                Full detail
              </Link>
            </div>
            <button
              type="button"
              onClick={closeDrawer}
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-ink-soft hover:bg-wash"
            >
              <X className="h-5 w-5" strokeWidth={2} aria-hidden />
            </button>
          </div>

          {/* Body — flex-1/min-h-0 so the sticky action bar below never
              scrolls away with it */}
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-md py-md md:px-lg md:py-lg"
            style={{ paddingBottom: "calc(var(--safe-bottom) + var(--spacing-lg))" }}
          >
            {/* CELLAR-05/06 — the wine leads. */}
            <WineDetailIdentity
              row={row}
              canManage={canManage}
              onDeleteImage={handleHeroImageDelete}
              deleteDisabled={heroImageUploading}
            />

            {/* Stock breakdown */}
            <section
              aria-label="Stock"
              className="rounded-lg card-surface p-md"
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
                <p className="mt-sm text-center text-[12px] text-grey">
                  ~{glassesLeft} glass{glassesLeft === 1 ? "" : "es"} left
                  {row.glass_pour_ml &&
                    ` · pour size ${(row.glass_pour_ml / ML_PER_OZ).toFixed(1)} oz`}
                </p>
              )}
              {row.bin_placements.map((placement) => (
                <p
                  key={placement.binId}
                  className="mt-2xs text-center font-mono text-[12px] text-grey"
                >
                  Bin {placement.zone ? `${placement.zone} › ` : ""}
                  {placement.code} · {placement.quantity}
                </p>
              ))}
              {/* Placed vs. unplaced are different facts — never merged into
                  one line ("Unplaced 8 · marked Row F14" read as a
                  contradiction — Kimi UX audit). */}
              {row.unplaced_count > 0 && row.bin_location && (
                <p className="mt-2xs text-center font-mono text-[13px] text-ink-soft">
                  Marked {row.bin_location}
                </p>
              )}
              {row.unplaced_count > 0 && (
                <p className="mt-2xs text-center font-mono text-[12px] text-grey">
                  {row.unplaced_count} unplaced
                  {row.suggested_bin && (
                    <> · Suggested {row.suggested_bin.zone ? `${row.suggested_bin.zone} › ` : ""}
                      {row.suggested_bin.code}</>
                  )}
                </p>
              )}
            </section>

            {/* CELLAR-06 — the wine's own reference data, promoted above the
                action zone. It was already built; it was simply underneath a
                stock-adjustment form that owned the panel. The service verbs
                a sommelier needs mid-pour did not move: they are pinned in the
                sticky action bar at the drawer's foot. */}
            {row.tasting_notes && (
              <section
                aria-label="Tasting notes"
                className="mt-md rounded-lg card-surface p-md"
              >
                <h3 className="text-caption font-medium uppercase text-grey mb-sm">Tasting notes</h3>
                <p className="text-[13px] text-ink-soft leading-relaxed whitespace-pre-wrap">
                  {row.tasting_notes}
                </p>
              </section>
            )}

            {row.retail_median != null && (
              <PricingSection row={row} canManage={canManage} />
            )}

            {row.drink_window_end != null && (
              <DrinkWindowSection row={row} />
            )}
            {row.serving_temp_label && row.serving_temp_min != null && row.serving_temp_max != null && (
              <ServingTempSection row={row} />
            )}
            {row.decant_minutes != null && row.decant_minutes > 0 && (
              <DecantTimeSection row={row} />
            )}

            {errorMsg && eightysix.pendingDirection === null && (
              <div
                role="alert"
                className="mt-md rounded-md border border-risk-ink/30 bg-risk-wash px-md py-sm text-[13px] text-risk-ink"
              >
                {errorMsg}
              </div>
            )}

            {row.open_bottle_id && row.theoretical_remaining_ml !== null && (
              <PartialBottleCloseout
                bottle={{
                  id: row.open_bottle_id,
                  wineId: row.wine_id,
                  theoreticalRemainingMl: row.theoretical_remaining_ml,
                  preservationMethod: row.preservation_method,
                  openedBy: row.opened_by,
                }}
                reasons={row.closeout_reason_codes}
                onComplete={() => startTransition(() => router.refresh())}
              />
            )}

            {/* Quick actions */}
            <section aria-label="Actions" className="mt-md flex flex-col gap-sm">
              {(row.sealed_count > 0 || canPour) && (
                <label className="text-[12px] text-grey">
                  Preservation method
                  <select
                    aria-label="Preservation method"
                    value={preservationMethod}
                    onChange={(event) => setPreservationMethod(event.target.value as PreservationMethod)}
                    className="mt-xs h-11 w-full rounded-pill border border-rule bg-surface px-sm text-[13px] text-ink"
                  >
                    <option value="none">None</option>
                    <option value="coravin">Coravin</option>
                    <option value="argon">Argon</option>
                    <option value="vacuum">Vacuum</option>
                  </select>
                </label>
              )}
              {/* Open bottle / Pour / Undo moved to the sticky action bar
                  at the drawer's foot — the service actions stay in reach
                  without scrolling (Kimi audit 2026-08-26). */}

              {/* GLOBAL-01 — one row, not a stack of full-width buttons. */}
              {canManage && (
                <div className="flex flex-wrap items-center gap-xs">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      eightysix.setPendingDirection(row.is_eightysixed ? "restored" : "eightysixed")
                    }
                    className={cn(
                      "inline-flex h-11 items-center justify-center gap-xs rounded-pill border px-md text-body-sm font-medium transition-colors disabled:opacity-60",
                      row.is_eightysixed
                        ? "border-accent bg-primary text-seal-ink hover:bg-primary-hover"
                        : "border-edge bg-surface text-ink hover:bg-wash",
                    )}
                  >
                    <PowerOff className="h-4 w-4" strokeWidth={2} aria-hidden />
                    {row.is_eightysixed ? "Restore" : "86 this wine"}
                  </button>
                  <EnrichControl wineId={row.wine_id} setErrorMsg={setErrorMsg} refresh={refresh} />
                  <button
                    type="button"
                    onClick={() => setEditOpen(true)}
                    className="inline-flex h-11 items-center justify-center gap-xs rounded-pill border border-edge bg-surface px-md text-body-sm font-medium text-ink hover:bg-wash transition-colors"
                  >
                    <Edit3 className="h-4 w-4" strokeWidth={2} aria-hidden />
                    Edit metadata
                  </button>
                </div>
              )}

              {/* OPP-1 (EV-1.2): merge duplicate — manager+ */}
              {canManage && row.duplicate_wine_ids.length > 0 && (duplicateRows ?? []).length > 0 && (
                <MergeDuplicatesPanel
                  wineId={row.wine_id}
                  duplicateRows={duplicateRows ?? []}
                  busy={busy}
                  setBusy={setBusy}
                  setErrorMsg={setErrorMsg}
                  toast={toast}
                  refresh={refresh}
                  onMerged={onClose}
                />
              )}

              {/* BND-058: Delete wine — owner only */}
              {isOwner && (
                <DeleteWinePanel
                  wineId={row.wine_id}
                  busy={busy}
                  setBusy={setBusy}
                  setErrorMsg={setErrorMsg}
                  toast={toast}
                  refresh={refresh}
                  onDeleted={onClose}
                />
              )}

              {/* CELLAR-06 — "Record comp or adjustment" used to open the
                  drawer and fill most of it. It is a back-office correction,
                  not the headline, so it is last. Still present, still
                  reachable, still `region "Stock adjustment"`. */}
              <StockAdjustmentForm
                wineId={row.wine_id}
                reasons={row.stock_adjustment_reason_codes}
                onComplete={() => startTransition(() => router.refresh())}
              />
            </section>

            {/* Add a hero image — quiet hairline row at the drawer's foot;
                a merchandising task, not a service task, so it no longer
                owns the top slot or wears the dashed SaaS empty-state. */}
            {canManage && !row.hero_image_url && (
              <section aria-label="Upload image" className="mt-md">
                <input
                  ref={heroImageInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleHeroImageUpload}
                  className="hidden"
                  id="hero-image-upload"
                />
                <label
                  htmlFor="hero-image-upload"
                  className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-xs rounded-lg border border-rule bg-surface text-[12px] font-medium uppercase tracking-[0.1em] text-grey hover:bg-wash hover:text-ink transition-colors"
                >
                  {heroImageUploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
                  ) : (
                    <Upload className="h-4 w-4" strokeWidth={2} aria-hidden />
                  )}
                  {heroImageUploading ? "Uploading..." : "Add hero image"}
                </label>
              </section>
            )}
          </div>

          {/* Sticky action bar — the drawer's service verbs (Open / Pour /
              Undo) pinned at the foot so they never sit below the fold
              (Kimi audit 2026-08-26). Reference sections scroll; actions
              don't. */}
          {(canPour || row.sealed_count > 0) && (
            <PourActionBar
              row={row}
              canPour={canPour}
              outOfStock={outOfStock}
              pickerItem={pickerItem}
              busy={busy}
              openBottleBusy={openBottleAction.busy}
              lastPour={lastPour}
              doOpenBottle={doOpenBottle}
              doPour={doPour}
              doUndo={doUndo}
              onOpenPicker={() => setPickerOpen(true)}
            />
          )}
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
      {eightysix.pendingDirection && row && (
        <NoteModal
          open={true}
          wineName={row.name}
          direction={eightysix.pendingDirection}
          busy={busy}
          error={errorMsg}
          onConfirm={(note: string | undefined) => eightysix.onConfirm86(note)}
          onCancel={() => eightysix.setPendingDirection(null)}
        />
      )}

      {/* Edit metadata modal */}
      {editOpen && row && (
        <EditMetadataModal
          wineId={row.wine_id}
          initial={{
            producer: row.producer,
            name: row.name,
            vintage: row.vintage,
            varietal: row.varietal,
            region: row.region,
            tasting_notes: row.tasting_notes,
            drink_window_start: row.drink_window_start,
            drink_window_end: row.drink_window_end,
            peak_year: row.peak_year,
          }}
          onClose={() => setEditOpen(false)}
        />
      )}
    </>
  );
}

export function drawerStateKey(row: CellarWineRow | null) {
  return row ? `${row.wine_id}:${row.opened_at ?? "sealed"}` : "none";
}
