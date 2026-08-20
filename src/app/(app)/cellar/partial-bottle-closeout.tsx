"use client";

import { useState } from "react";
import type { PreservationMethod } from "@/lib/partial-bottles/math";

type Bottle = {
  id: string;
  wineId: string;
  theoreticalRemainingMl: number;
  preservationMethod: PreservationMethod;
  openedBy: string | null;
};

type Reason = { id: string; label: string; category: string };

const LABELS: Record<PreservationMethod, string> = {
  argon: "Argon",
  coravin: "Coravin",
  none: "None",
  vacuum: "Vacuum",
};

export function PartialBottleCloseout({
  bottle,
  reasons,
  onComplete,
}: {
  bottle: Bottle;
  reasons: Reason[];
  onComplete?: () => void;
}) {
  const form = useCloseout(bottle, onComplete);

  return (
    <section aria-label="Partial bottle close-out" className="mt-md rounded-md border border-border bg-white p-md">
      <BottleSummary bottle={bottle} />
      <CloseoutFields reasons={reasons} form={form} />
    </section>
  );
}

function useCloseout(bottle: Bottle, onComplete?: () => void) {
  const [actual, setActual] = useState(String(Math.max(0, bottle.theoreticalRemainingMl)));
  const [writeoff, setWriteoff] = useState("0");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actualMl = Number(actual);
  const writtenOffMl = Number(writeoff);
  const invalid = actual.trim() === "" || writeoff.trim() === "" ||
    !Number.isInteger(actualMl) || actualMl < 0 ||
    !Number.isInteger(writtenOffMl) || writtenOffMl < 0 ||
    (writtenOffMl > 0 && !reason);

  async function closeBottle() {
    setBusy(true);
    setError(null);
    try {
      await postCloseout(bottle.wineId, actualMl, writtenOffMl, reason);
      onComplete?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Close-out failed.");
    } finally {
      setBusy(false);
    }
  }

  return {
    actual,
    setActual,
    writeoff,
    setWriteoff,
    reason,
    setReason,
    writtenOffMl,
    busy,
    error,
    invalid,
    closeBottle,
  };
}

async function postCloseout(
  wineId: string,
  actualRemainingMl: number,
  writtenOffMl: number,
  reasonCodeId: string,
) {
  const response = await fetch("/api/open-bottles/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wine_id: wineId,
      actual_remaining_ml: actualRemainingMl,
      written_off_ml: writtenOffMl,
      reason_code_id: reasonCodeId || undefined,
    }),
  });
  const payload = await response.json().catch(() => null) as
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Close-out failed.");
  }
}

type CloseoutForm = ReturnType<typeof useCloseout>;

function BottleSummary({ bottle }: { bottle: Bottle }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-sm">
        <h3 className="text-[13px] font-semibold text-ink">Open bottle</h3>
        <span className="text-[12px] text-ink-muted">{LABELS[bottle.preservationMethod]}</span>
      </div>
      <p className="mt-xs text-[12px] text-ink-muted">
        {bottle.theoreticalRemainingMl} ml theoretical remaining
        {bottle.openedBy ? ` · opened by ${bottle.openedBy}` : ""}
      </p>
    </>
  );
}

function CloseoutFields({ reasons, form }: { reasons: Reason[]; form: CloseoutForm }) {
  return (
    <>
      <div className="mt-sm grid grid-cols-2 gap-sm">
        <Field name="actual_remaining_ml" label="Actual remaining (ml)" value={form.actual} onChange={form.setActual} />
        <Field name="written_off_ml" label="Write-off (ml)" value={form.writeoff} onChange={form.setWriteoff} />
      </div>
      <label className="mt-sm block text-[12px] text-ink-muted">
        Reason
        <select value={form.reason} onChange={(event) => form.setReason(event.target.value)} className="mt-xs h-10 w-full rounded-sm border border-border bg-white px-sm text-[13px] text-ink">
          <option value="">{form.writtenOffMl > 0 ? "Select a reason" : "No reason"}</option>
          {reasons.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      {form.error && <p role="alert" className="mt-sm text-[12px] text-danger">{form.error}</p>}
      <button type="button" disabled={form.busy || form.invalid} onClick={form.closeBottle} className="mt-sm h-10 w-full rounded-sm border border-border-strong bg-white text-[13px] font-medium text-ink hover:bg-surface-muted disabled:opacity-50">
        {form.busy ? "Closing…" : "Close bottle"}
      </button>
    </>
  );
}

function Field({ name, label, value, onChange }: { name: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="text-[12px] text-ink-muted">
      {label}
      <input name={name} type="number" min="0" step="1" value={value} onChange={(event) => onChange(event.target.value)} className="mt-xs h-10 w-full rounded-sm border border-border bg-white px-sm font-mono text-[13px] text-ink" />
    </label>
  );
}
