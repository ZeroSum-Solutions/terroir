"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2 } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type WineMetadata = {
  producer: string;
  name: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  tasting_notes: string | null;
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

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: onClose,
    enabled: true,
  });

  const handleSave = useCallback(async () => {
    if (!producer.trim() || !name.trim()) return;

    setBusy(true);
    setErrorMsg(null);

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

    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }

    try {
      const res = await fetch(`/api/wines/${wineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(
          payload?.error?.message ?? `Update failed (${res.status}).`,
        );
      }
      toast.success("Metadata updated");
      onClose();
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }, [
    producer, name, vintage, varietal, region, tastingNotes,
    initial, wineId, onClose, router, toast,
  ]);

  const dirty =
    producer.trim() !== initial.producer ||
    name.trim() !== initial.name ||
    (vintage.trim() === "" ? null : parseInt(vintage, 10)) !== initial.vintage ||
    (varietal.trim() || null) !== (initial.varietal ?? null) ||
    (region.trim() || null) !== (initial.region ?? null) ||
    (tastingNotes.trim() || null) !== (initial.tasting_notes ?? null);

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
