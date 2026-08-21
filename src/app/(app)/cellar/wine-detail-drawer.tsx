"use client";

import { useRef, useState, useTransition, useCallback } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { X, PackageOpen, PowerOff, Edit3, ChevronDown, Sparkles, Loader2, Undo2, Upload, Trash2 } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { useToast } from "@/lib/toast";
import { ML_PER_OZ } from "@/lib/units";
import { cn } from "@/lib/utils";
import { NoteModal } from "./note-modal";
import { EditMetadataModal } from "./edit-metadata-modal";
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
import type { PreservationMethod } from "@/lib/partial-bottles/math";
import { PartialBottleCloseout } from "./partial-bottle-closeout";
import { StockAdjustmentForm } from "./stock-adjustment-form";

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

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // BND-119: track last pour for undo.
  const [lastPour, setLastPour] = useState<{ ml: number } | null>(null);

  const [pendingDirection, setPendingDirection] = useState<
    "eightysixed" | "restored" | null
  >(null);

  // BND-058: delete wine confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // OPP-1 (EV-1.2) — merge-duplicate confirmation state: the wine_id of the
  // duplicate awaiting confirmation, or null.
  const [mergeConfirm, setMergeConfirm] = useState<string | null>(null);
  const doMerge = useCallback(
    async (sourceId: string) => {
      if (!row) return;
      setErrorMsg(null);
      setBusy(true);
      try {
        const res = await fetch("/api/wines/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The open drawer's wine is kept; the duplicate collapses into it.
          body: JSON.stringify({ source_id: sourceId, target_id: row.wine_id }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(payload?.error?.message ?? `Merge failed (${res.status})`);
        }
        toast.success("Duplicate merged — stock and history combined.");
        setMergeConfirm(null);
        startTransition(() => router.refresh());
        onClose();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Merge failed.");
      } finally {
        setBusy(false);
      }
    },
    [row, router, startTransition, toast, onClose],
  );

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: onClose,
    enabled: row !== null,
    paused: pendingDirection !== null,
  });

  // BND-121: manually open a bottle without recording a pour
  const [openBottleBusy, setOpenBottleBusy] = useState(false);
  const [preservationMethod, setPreservationMethod] =
    useState<PreservationMethod>(row?.preservation_method ?? "none");

  const doOpenBottle = useCallback(
    async () => {
      if (!row) return;
      setErrorMsg(null);
      setOpenBottleBusy(true);
      try {
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
        startTransition(() => router.refresh());
      } catch (err) {
        toast.error("Open bottle failed");
        setErrorMsg(err instanceof Error ? err.message : "Failed to open bottle.");
      } finally {
        setOpenBottleBusy(false);
      }
    },
    [row, router, toast, preservationMethod],
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
          const sourceLabel = payload.source === "claude_inference"
            ? "Claude AI"
            : payload.source === "lwin_fallback"
              ? "LWIN catalog"
              : "rule engine";
          setEnrichMsg(`Enriched via ${sourceLabel}.`);
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

  const handleImageUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !row) return;
      setUploading(true);
      setErrorMsg(null);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`/api/wines/${row.wine_id}/image`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(payload?.error?.message ?? `Upload failed (${res.status}).`);
        }
        toast.success("Image uploaded");
        startTransition(() => router.refresh());
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [row, router, toast],
  );

  const handleImageDelete = useCallback(
    async () => {
      if (!row) return;
      setUploading(true);
      setErrorMsg(null);
      try {
        const res = await fetch(`/api/wines/${row.wine_id}/image`, { method: "DELETE" });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(payload?.error?.message ?? `Delete failed (${res.status}).`);
        }
        toast.success("Image removed");
        startTransition(() => router.refresh());
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Delete failed.");
      } finally {
        setUploading(false);
      }
    },
    [row, router, toast],
  );

  // BND-058: delete the wine after confirming no references exist.
  const doDelete = useCallback(
    async () => {
      if (!row) return;
      setDeleteConfirm(false);
      setErrorMsg(null);
      setBusy(true);
      try {
        const res = await fetch(`/api/cellar/${row.wine_id}`, { method: "DELETE" });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: { code?: string; message?: string } }
            | null;
          throw new Error(
            payload?.error?.message ?? `Delete failed (${res.status}).`,
          );
        }
        toast.success("Wine deleted");
        onClose();
        startTransition(() => router.refresh());
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Delete failed.");
      } finally {
        setBusy(false);
      }
    },
    [row, router, onClose, toast],
  );

  const onConfirm86 = async (note: string | undefined) => {
    if (!row || !pendingDirection) return;
    const direction = pendingDirection;
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
      setPendingDirection(null);
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

  const canPour = Boolean(
    row.glass_pour_ml &&
    row.glass_pour_ml > 0 &&
    !row.is_eightysixed,
  );
  const outOfStock = Boolean(canPour && totalMl !== null && totalMl < row.glass_pour_ml!);

  return (
    <>
      {row && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-lg bg-canvas md:absolute md:inset-y-0 md:right-0 md:left-auto md:w-[420px] md:rounded-none md:border-l md:border-hairline"
          style={{ maxHeight: "calc(100dvh - 3.5rem)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-hairline px-md py-sm">
            <h2 id={headingId} className="font-serif text-[17px] font-medium text-ink leading-snug">
              <span>{row.producer}</span> <span>{row.name}</span>
              {row.vintage != null && (
                <span className="ml-1 font-sans text-[13px] font-light text-grey"> {row.vintage}</span>
              )}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>

          {/* Body */}
          <div
            className="overflow-y-auto px-md py-md md:px-lg md:py-lg"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
          >
            {/* Hero image */}
            {row.hero_image_url && (
              <section aria-label="Hero image" className="mb-md">
                <div className="relative rounded-lg overflow-hidden border border-hairline bg-bridge-surface">
                  <Image
                    src={row.hero_image_url}
                    alt={`${row.producer} ${row.name}`}
                    width={800}
                    height={384}
                    unoptimized
                    className="w-full h-48 object-cover"
                  />
                  {canManage && (
                    <button
                      type="button"
                      onClick={handleImageDelete}
                      disabled={uploading}
                      className="absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-pill bg-black/50 text-white hover:bg-black/70 disabled:opacity-40"
                      aria-label="Remove image"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
                    </button>
                  )}
                </div>
              </section>
            )}

            {canManage && !row.hero_image_url && (
              <section aria-label="Upload image" className="mb-md">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleImageUpload}
                  className="hidden"
                  id="hero-image-upload"
                />
                <label
                  htmlFor="hero-image-upload"
                  className="flex h-[48px] w-full cursor-pointer items-center justify-center gap-xs rounded-lg border border-dashed border-beige-deep bg-white text-[13px] font-medium text-grey hover:bg-bridge-surface transition-colors"
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
                  ) : (
                    <Upload className="h-4 w-4" strokeWidth={2} aria-hidden />
                  )}
                  {uploading ? "Uploading..." : "Upload hero image"}
                </label>
              </section>
            )}

            {/* Stock breakdown */}
            <section
              aria-label="Stock"
              className="rounded-lg border border-hairline bg-white p-md"
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
              {row.unplaced_count > 0 && (
                <p className="mt-2xs text-center font-mono text-[12px] text-grey">
                  Unplaced {row.unplaced_count}
                  {row.bin_location && <> · marked {row.bin_location}</>}
                  {row.suggested_bin && (
                    <> · Suggested {row.suggested_bin.zone ? `${row.suggested_bin.zone} › ` : ""}
                      {row.suggested_bin.code}</>
                  )}
                </p>
              )}
            </section>

            {/* Tasting notes */}
            {row.tasting_notes && (
              <section
                aria-label="Tasting notes"
                className="mt-md rounded-lg border border-hairline bg-white p-md"
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

            {errorMsg && pendingDirection === null && (
              <div
                role="alert"
                className="mt-md rounded-md border border-primary/30 bg-blush-wash px-md py-sm text-[13px] text-primary"
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
              <StockAdjustmentForm
                wineId={row.wine_id}
                reasons={row.stock_adjustment_reason_codes}
                onComplete={() => startTransition(() => router.refresh())}
              />
              {(row.sealed_count > 0 || canPour) && (
                <label className="text-[12px] text-grey">
                  Preservation method
                  <select
                    aria-label="Preservation method"
                    value={preservationMethod}
                    onChange={(event) => setPreservationMethod(event.target.value as PreservationMethod)}
                    className="mt-xs h-10 w-full rounded-pill border border-hairline bg-white px-sm text-[13px] text-ink"
                  >
                    <option value="none">None</option>
                    <option value="coravin">Coravin</option>
                    <option value="argon">Argon</option>
                    <option value="vacuum">Vacuum</option>
                  </select>
                </label>
              )}
              {/* BND-121: Manually open a bottle without recording a pour */}
              {row.sealed_count > 0 && (
                <button
                  type="button"
                  disabled={openBottleBusy}
                  onClick={doOpenBottle}
                  className="flex h-[48px] items-center justify-center gap-xs rounded-pill border border-ink/25 bg-white text-[14px] font-medium text-ink hover:bg-bridge-surface transition-colors disabled:opacity-60"
                >
                  <PackageOpen className="h-4 w-4" strokeWidth={2} aria-hidden />
                  {openBottleBusy ? "Opening..." : "Open bottle"}
                </button>
              )}
              {canPour && (
                <div className="flex gap-xs">
                  <button
                    type="button"
                    disabled={busy || outOfStock}
                    onClick={() => row.glass_pour_ml && doPour(row.glass_pour_ml)}
                    className={cn(
                      "h-[56px] flex-1 rounded-pill bg-primary text-[15px] font-medium text-white transition-colors",
                      "hover:bg-primary-hover disabled:opacity-60",
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
                      className="flex h-[56px] w-[56px] items-center justify-center rounded-pill border border-hairline bg-white text-grey hover:bg-bridge-surface disabled:opacity-60"
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
                  className="flex h-[40px] items-center justify-center gap-xs rounded-pill border border-amber/40 bg-amber-wash text-[13px] font-medium text-amber transition-colors hover:bg-amber-wash/70 disabled:opacity-60"
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
                    "flex h-[48px] items-center justify-center gap-xs rounded-pill border text-[14px] font-medium transition-colors disabled:opacity-60",
                    row.is_eightysixed
                      ? "border-primary bg-primary text-white hover:bg-primary-hover"
                      : "border-ink/25 bg-white text-ink hover:bg-bridge-surface",
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
                      "flex h-[40px] items-center justify-center gap-xs rounded-pill border text-[13px] font-medium transition-colors disabled:opacity-60",
                      enrichMsg
                        ? "border-sage-ink/30 bg-sage-wash text-sage-ink"
                        : "border-ink/25 bg-white text-ink hover:bg-bridge-surface",
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
                    <p className="text-[11px] text-grey">{enrichMsg}</p>
                  )}
                </div>
              )}

              {canManage && (
                <button
                  type="button"
                  onClick={() => setEditOpen(true)}
                  className="flex h-[40px] items-center justify-center gap-xs rounded-pill border border-ink/25 bg-white text-[13px] font-medium text-ink hover:bg-bridge-surface transition-colors"
                >
                  <Edit3 className="h-4 w-4" strokeWidth={2} aria-hidden />
                  Edit metadata
                </button>
              )}

              {/* OPP-1 (EV-1.2): merge duplicate — manager+ */}
              {canManage && row.duplicate_wine_ids.length > 0 && (duplicateRows ?? []).length > 0 && (
                <div
                  data-merge-duplicates
                  className="flex flex-col gap-xs rounded-lg border border-amber/30 bg-amber-wash/40 p-sm"
                >
                  <p className="text-[13px] font-medium text-ink">
                    Possible duplicate record{(duplicateRows ?? []).length === 1 ? "" : "s"}
                  </p>
                  <p className="text-[12px] text-grey">
                    Same wine, same vintage, same format. Merging combines stock
                    and keeps the full history. Different vintages are never
                    merged — they stay linked as siblings.
                  </p>
                  {(duplicateRows ?? []).map((dup) =>
                    mergeConfirm === dup.wine_id ? (
                      <div key={dup.wine_id} className="flex gap-xs">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setMergeConfirm(null)}
                          className="flex-1 h-[36px] rounded-pill border border-hairline bg-white text-[13px] font-medium text-ink hover:bg-bridge-surface disabled:opacity-60"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => doMerge(dup.wine_id)}
                          className="flex-1 h-[36px] rounded-pill bg-primary text-[13px] font-medium text-white hover:bg-primary-hover disabled:opacity-60"
                        >
                          {busy ? "Merging..." : "Confirm merge"}
                        </button>
                      </div>
                    ) : (
                      <button
                        key={dup.wine_id}
                        type="button"
                        disabled={busy}
                        onClick={() => setMergeConfirm(dup.wine_id)}
                        className="flex h-[36px] items-center justify-center rounded-pill border border-ink/25 bg-white px-sm text-[13px] font-medium text-ink hover:bg-bridge-surface disabled:opacity-60"
                      >
                        Merge &ldquo;{dup.producer} {dup.name}
                        {dup.vintage ? ` ${dup.vintage}` : ""}&rdquo; into this record
                      </button>
                    ),
                  )}
                </div>
              )}

              {/* BND-058: Delete wine — owner only */}
              {isOwner && (
                <>
                  {deleteConfirm ? (
                    <div className="flex flex-col gap-xs rounded-lg border border-primary/30 bg-blush-wash p-sm">
                      <p className="text-[13px] font-medium text-primary">
                        Permanently delete this wine?
                      </p>
                      <p className="text-[12px] text-primary/80">
                        This action cannot be undone. Consider using &ldquo;86 this wine&rdquo; instead.
                      </p>
                      <div className="flex gap-xs mt-xs">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDeleteConfirm(false)}
                          className="flex-1 h-[36px] rounded-pill border border-hairline bg-white text-[13px] font-medium text-ink hover:bg-bridge-surface disabled:opacity-60"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={doDelete}
                          className="flex-1 h-[36px] rounded-pill bg-primary text-[13px] font-medium text-white hover:bg-primary-hover disabled:opacity-60"
                        >
                          {busy ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setDeleteConfirm(true)}
                      className="flex h-[40px] items-center justify-center gap-xs rounded-pill border border-primary/30 bg-white text-[13px] font-medium text-primary hover:bg-blush-wash transition-colors disabled:opacity-60"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
                      Delete wine
                    </button>
                  )}
                </>
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
          open={true}
          wineName={row.name}
          direction={pendingDirection}
          busy={busy}
          error={errorMsg}
          onConfirm={(note: string | undefined) => onConfirm86(note)}
          onCancel={() => setPendingDirection(null)}
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
      <span className="text-caption font-medium uppercase text-grey">
        {label}
      </span>
      <span
        className={cn(
          "text-[14px] font-semibold leading-none",
          tone === "warn" && "text-amber",
          tone === "ok" && "text-sage-ink",
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
    row.current_unit_cost,
    row.size_ml,
    row.glass_pour_ml,
    row.current_glass_price,
  );
  const glassStatus = getGlassStatus(pourCostPct, targetPourCost);
  const bottleStatus = getBottleStatus(markupRatio, targetMarkup);

  return (
    <section
      aria-label="Pricing"
      className="mt-md rounded-lg border border-hairline bg-white p-md"
    >
      <h3 className="text-caption font-medium uppercase text-grey mb-sm">Pricing</h3>

      <div className="space-y-sm">
        {/* Glass pour row */}
        {row.current_glass_price != null && row.glass_pour_ml && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] font-medium text-ink">
                ${row.current_glass_price.toFixed(2)}{" "}
                <span className="font-normal text-grey">
                  / {(row.glass_pour_ml / ML_PER_OZ).toFixed(1)} oz glass
                </span>
              </p>
              {glassStatus !== "on_target" && glassStatus !== "unknown" && (
                <p className="text-[12px] text-grey">
                  {formatPricingStatusLabel(glassStatus)}
                </p>
              )}
            </div>
            <PriceBand
              bottleList={row.current_bottle_price}
              retailReference={row.retail_median}
              targetMarkup={targetMarkup}
              size="mini"
            />
          </div>
        )}

        {/* Bottle row */}
        {row.current_bottle_price != null && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[14px] font-medium text-ink">
                ${row.current_bottle_price.toFixed(2)}{" "}
                <span className="font-normal text-grey">/ bottle</span>
              </p>
              {bottleStatus !== "on_target" && bottleStatus !== "unknown" && (
                <p className="text-[12px] text-grey">
                  {formatPricingStatusLabel(bottleStatus)}
                </p>
              )}
            </div>
            <PriceBand
              bottleList={row.current_bottle_price}
              retailReference={row.retail_median}
              targetMarkup={targetMarkup}
              size="mini"
            />
          </div>
        )}

        {isRetailStale(row.retail_refreshed_at ?? undefined) && (
          <p className="text-[11px] text-grey">
            Retail data is over 30 days old. May not reflect current pricing.
          </p>
        )}
      </div>

      {canManage && row.current_bottle_price != null && (
        <div className="mt-md">
          <PricingTargetOverride
            wineId={row.wine_id}
            perWinePourCostPct={row.pricing_target_pour_cost_pct}
            perWineMarkupRatio={row.pricing_target_markup_ratio}
            housePourCostPct={
              row.restaurant_default_target_pour_cost_pct ?? targetPourCost
            }
            houseMarkupRatio={
              row.restaurant_default_target_markup_ratio ?? targetMarkup
            }
          />
        </div>
      )}
    </section>
  );
}


/**
 * BND-070 — DecantTimeSection. Shows recommended decant time
 * when enrichment has set it and it's > 0 minutes.
 */
function DecantTimeSection({ row }: { row: CellarWineRow }) {
  const hours = row.decant_minutes! >= 60
    ? Math.floor(row.decant_minutes! / 60)
    : 0;
  const mins = row.decant_minutes! % 60;

  let display: string;
  if (hours > 0 && mins > 0) {
    display = hours + "h " + mins + "m";
  } else if (hours > 0) {
    display = hours + " hour" + (hours === 1 ? "" : "s");
  } else {
    display = mins + " min";
  }

  return (
    <section
      aria-label="Decant time"
      className="mt-md rounded-lg border border-hairline bg-white p-md"
    >
      <h3 className="text-caption font-medium uppercase text-grey mb-xs">Decant time</h3>
      <p className="text-[14px] text-ink-soft">
        {display}
      </p>
    </section>
  );
}

/**
 * BND-069 — ServingTempSection. Shows recommended serving temperature
 * when enrichment has set it.
 */
function ServingTempSection({ row }: { row: CellarWineRow }) {
  return (
    <section
      aria-label="Serving temperature"
      className="mt-md rounded-lg border border-hairline bg-white p-md"
    >
      <h3 className="text-caption font-medium uppercase text-grey mb-xs">Serving temperature</h3>
      <p className="text-[14px] text-ink-soft">
        {row.serving_temp_min}–{row.serving_temp_max}°F
      </p>
      {row.serving_temp_label && (
        <p className="mt-2xs text-[12px] text-grey">{row.serving_temp_label}</p>
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

  // BND-071 — status pill color mapping (contract badge tokens).
  const pillStyle = (() => {
    switch (status) {
      case "hold":
        return "bg-bridge-surface text-grey";
      case "optimal":
        return "bg-sage-wash text-sage-ink";
      case "drink_now":
        return "bg-powder-wash text-powder-ink";
      case "past_peak":
        return "bg-blush-wash text-primary";
      default:
        return "bg-bridge-surface text-grey";
    }
  })();

  return (
    <section
      aria-label="Drink window"
      className="mt-md rounded-lg border border-hairline bg-white p-md"
    >
      <h3 className="text-caption font-medium uppercase text-grey mb-sm">Drink window</h3>

      {/* BND-071 — start / peak / end year labels above the timeline. */}
      <div className="mb-xs flex items-center justify-between text-[11px] font-mono text-grey">
        <span>Start {row.drink_window_start}</span>
        {row.peak_year != null && (
          <span className="text-primary font-medium">Peak {row.peak_year}</span>
        )}
        <span>End {row.drink_window_end}</span>
      </div>

      <DrinkWindowTimeline
        start={row.drink_window_start as number}
        end={row.drink_window_end as number}
        peak={row.peak_year as number | undefined}
      />

      <div className="mt-sm flex items-center justify-between text-[12px]">
        {/* BND-071 — status pill, contract badge mapping. */}
        <span
          className={`inline-flex items-center rounded-pill px-sm py-2xs text-[10.5px] font-medium uppercase tracking-wide ${pillStyle}`}
        >
          {formatStatusLabel(status, yearsLeft)}
        </span>
        {yearsLeft !== null && (
          <span className="text-grey">
            {yearsLeft >= 0
              ? `${yearsLeft} year${yearsLeft === 1 ? "" : "s"} left`
              : `${Math.abs(yearsLeft)} year${Math.abs(yearsLeft) === 1 ? "" : "s"} past`}
          </span>
        )}
      </div>

      {row.review_excerpt && (
        <blockquote className="mt-sm border-l-2 border-blush-wash pl-sm text-[12px] text-grey italic leading-relaxed">
          {row.review_excerpt}
          {row.rating && row.rating_source && (
            <cite className="mt-2xs block not-italic font-medium text-grey">
              {row.rating} pts — {row.rating_source}
            </cite>
          )}
        </blockquote>
      )}
    </section>
  );
}
