"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2 } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
} from "@/lib/api/idempotency-client";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const metadataCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:wine-metadata"),
});

type WineMetadata = {
  producer: string;
  name: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  tasting_notes: string | null;
  drink_window_start: number | null;
  drink_window_end: number | null;
  peak_year: number | null;
};

export function EditMetadataModal({
  wineId,
  initial,
  onClose,
}: {
  wineId: string;
  initial: WineMetadata;
  onClose: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const toast = useToast();

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [producer, setProducer] = useState(initial.producer);
  const [name, setName] = useState(initial.name);
  const [vintage, setVintage] = useState(
    initial.vintage != null ? String(initial.vintage) : "",
  );
  const [varietal, setVarietal] = useState(initial.varietal ?? "");
  const [region, setRegion] = useState(initial.region ?? "");
  const [tastingNotes, setTastingNotes] = useState(
    initial.tasting_notes ?? "",
  );
  // BND-277 — manual drink-window override (#72)
  const [dwStart, setDwStart] = useState(
    initial.drink_window_start != null ? String(initial.drink_window_start) : "",
  );
  const [dwEnd, setDwEnd] = useState(
    initial.drink_window_end != null ? String(initial.drink_window_end) : "",
  );
  const [dwPeak, setDwPeak] = useState(
    initial.peak_year != null ? String(initial.peak_year) : "",
  );

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: onClose,
    enabled: true,
  });

  const handleSave = useCallback(async () => {
    if (!producer.trim() || !name.trim() || savingRef.current) return;

    const body: Record<string, unknown> = {};
    if (producer.trim() !== initial.producer) body.producer = producer.trim();
    if (name.trim() !== initial.name) body.name = name.trim();

    const parsedVintage =
      vintage.trim() === "" ? null : parseInt(vintage, 10);
    if (parsedVintage !== initial.vintage) {
      body.vintage = parsedVintage;
    }

    const trimmedVarietal = varietal.trim() || null;
    if (trimmedVarietal !== (initial.varietal ?? null)) {
      body.varietal = trimmedVarietal;
    }

    const trimmedRegion = region.trim() || null;
    if (trimmedRegion !== (initial.region ?? null)) {
      body.region = trimmedRegion;
    }

    const trimmedNotes = tastingNotes.trim() || null;
    if (trimmedNotes !== (initial.tasting_notes ?? null)) {
      body.tasting_notes = trimmedNotes;
    }

    // BND-277 — drink-window override (#72)
    const parsedDwStart = dwStart.trim() === "" ? null : parseInt(dwStart, 10);
    if (parsedDwStart !== (initial.drink_window_start ?? null)) {
      body.drink_window_start = parsedDwStart;
    }

    const parsedDwEnd = dwEnd.trim() === "" ? null : parseInt(dwEnd, 10);
    if (parsedDwEnd !== (initial.drink_window_end ?? null)) {
      body.drink_window_end = parsedDwEnd;
    }

    const parsedDwPeak = dwPeak.trim() === "" ? null : parseInt(dwPeak, 10);
    if (parsedDwPeak !== (initial.peak_year ?? null)) {
      body.peak_year = parsedDwPeak;
    }

    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }

    savingRef.current = true;
    setBusy(true);
    setErrorMsg(null);

    try {
      const { response, data } = await metadataCommands.json<unknown>({
        slot: `metadata:${wineId}`,
        url: `/api/wines/${wineId}`,
        method: "PATCH",
        json: body,
      });
      if (!response.ok) {
        throw new Error(
          readApiError(data, `Update failed (${response.status}).`).message,
        );
      }
      toast.success("Metadata updated");
      onClose();
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Update failed.");
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }, [
    producer, name, vintage, varietal, region, tastingNotes,
    dwStart, dwEnd, dwPeak,
    initial, wineId, onClose, router, toast,
  ]);

  const dirty =
    producer.trim() !== initial.producer ||
    name.trim() !== initial.name ||
    (vintage.trim() === "" ? null : parseInt(vintage, 10)) !== initial.vintage ||
    (varietal.trim() || null) !== (initial.varietal ?? null) ||
    (region.trim() || null) !== (initial.region ?? null) ||
    (tastingNotes.trim() || null) !== (initial.tasting_notes ?? null) ||
    (dwStart.trim() === "" ? null : parseInt(dwStart, 10)) !== (initial.drink_window_start ?? null) ||
    (dwEnd.trim() === "" ? null : parseInt(dwEnd, 10)) !== (initial.drink_window_end ?? null) ||
    (dwPeak.trim() === "" ? null : parseInt(dwPeak, 10)) !== (initial.peak_year ?? null);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-metadata-heading"
      className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[85dvh] flex-col rounded-t-lg bg-surface shadow-xl md:inset-0 md:m-auto md:h-fit md:max-h-[90dvh] md:w-[480px] md:rounded-lg"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-md py-sm shrink-0">
        <h2
          id="edit-metadata-heading"
          className="text-[15px] font-semibold text-ink"
        >
          Edit wine
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          disabled={busy}
          className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted"
        >
          <X className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto px-md py-md space-y-md">
        {/* Producer */}
        <Field label="Producer" htmlFor="edit-producer">
          <input
            id="edit-producer"
            type="text"
            value={producer}
            onChange={(e) => setProducer(e.target.value)}
            className="h-[40px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
          />
        </Field>

        {/* Name */}
        <Field label="Name" htmlFor="edit-name">
          <input
            id="edit-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-[40px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
          />
        </Field>

        {/* Vintage */}
        <Field label="Vintage" htmlFor="edit-vintage">
          <input
            id="edit-vintage"
            type="number"
            min="1900"
            max="2100"
            value={vintage}
            onChange={(e) => setVintage(e.target.value)}
            placeholder="e.g. 2020"
            className="h-[40px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
          />
        </Field>

        {/* Varietal */}
        <Field label="Varietal" htmlFor="edit-varietal">
          <input
            id="edit-varietal"
            type="text"
            value={varietal}
            onChange={(e) => setVarietal(e.target.value)}
            placeholder="e.g. Cabernet Sauvignon"
            className="h-[40px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
          />
        </Field>

        {/* Region */}
        <Field label="Region" htmlFor="edit-region">
          <input
            id="edit-region"
            type="text"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="e.g. Napa Valley"
            className="h-[40px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
          />
        </Field>

        {/* Tasting Notes */}
        <Field label="Tasting notes" htmlFor="edit-tasting-notes">
          <textarea
            id="edit-tasting-notes"
            value={tastingNotes}
            onChange={(e) => setTastingNotes(e.target.value)}
            placeholder="Enter free-form tasting notes..."
            rows={4}
            className="w-full rounded-sm border border-border bg-white px-sm py-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft resize-y"
          />
        </Field>

        {/* BND-277 — drink-window override (#72) */}
        <fieldset className="rounded-sm border border-border p-sm">
          <legend className="text-[12px] font-medium text-ink-muted px-xs">
            Drink window (manual override)
          </legend>
          <p className="text-[11px] text-ink-subtle mb-sm px-xs">
            Setting any of these locks the drink window, preventing future
            enrichment from changing it.
          </p>
          <div className="grid grid-cols-3 gap-xs">
            <Field label="Start year" htmlFor="edit-dw-start">
              <input
                id="edit-dw-start"
                type="number"
                min="1900"
                max="2100"
                value={dwStart}
                onChange={(e) => setDwStart(e.target.value)}
                placeholder="e.g. 2025"
                className="h-[40px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
              />
            </Field>
            <Field label="Peak year" htmlFor="edit-dw-peak">
              <input
                id="edit-dw-peak"
                type="number"
                min="1900"
                max="2100"
                value={dwPeak}
                onChange={(e) => setDwPeak(e.target.value)}
                placeholder="e.g. 2030"
                className="h-[40px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
              />
            </Field>
            <Field label="End year" htmlFor="edit-dw-end">
              <input
                id="edit-dw-end"
                type="number"
                min="1900"
                max="2100"
                value={dwEnd}
                onChange={(e) => setDwEnd(e.target.value)}
                placeholder="e.g. 2035"
                className="h-[40px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
              />
            </Field>
          </div>
        </fieldset>

        {errorMsg && (
          <div
            role="alert"
            className="rounded-sm border border-danger/30 bg-danger-soft px-md py-sm text-[13px] text-danger"
          >
            {errorMsg}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-sm border-t border-border px-md py-sm shrink-0">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="flex h-[40px] items-center rounded-sm border border-border bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !producer.trim() || !name.trim()}
          className={cn(
            "flex h-[40px] items-center gap-sm rounded-sm px-md text-[13px] font-medium text-white transition-colors",
            dirty
              ? "bg-accent hover:bg-accent-hover"
              : "bg-accent/50",
            "disabled:opacity-40",
          )}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />}
          Save changes
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2xs">
      <label
        htmlFor={htmlFor}
        className="text-[12px] font-medium text-ink-muted"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
