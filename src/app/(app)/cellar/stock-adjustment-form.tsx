"use client";

import { useState } from "react";

type Reason = { id: string; label: string; category: string };

export function StockAdjustmentForm({
  wineId,
  reasons,
  onComplete,
}: {
  wineId: string;
  reasons: Reason[];
  onComplete?: () => void;
}) {
  const form = useStockAdjustment(wineId, onComplete);
  return (
    <section aria-label="Stock adjustment" className="rounded-sm border border-border bg-white p-sm">
      <h3 className="text-[13px] font-semibold text-ink">Record comp or adjustment</h3>
      <StockAdjustmentFields reasons={reasons} form={form} />
    </section>
  );
}

function useStockAdjustment(wineId: string, onComplete?: () => void) {
  const [kind, setKind] = useState<"comp" | "adjustment">("comp");
  const [unit, setUnit] = useState<"bottles" | "ml">("bottles");
  const [quantity, setQuantity] = useState("1");
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const numericQuantity = Number(quantity);
  const invalid = !Number.isSafeInteger(numericQuantity) || numericQuantity === 0 || !reasonId;

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/stock-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wine_id: wineId,
          kind,
          [unit]: numericQuantity,
          reason_code_id: reasonId,
          note: note.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => null) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Unable to record event.");
      }
      setMessage("Event recorded.");
      setNote("");
      onComplete?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to record event.");
    } finally {
      setBusy(false);
    }
  }

  return { kind, setKind, unit, setUnit, quantity, setQuantity, reasonId,
    setReasonId, note, setNote, busy, message, invalid, submit };
}

type StockAdjustmentFormState = ReturnType<typeof useStockAdjustment>;

function StockAdjustmentFields({
  reasons,
  form,
}: {
  reasons: Reason[];
  form: StockAdjustmentFormState;
}) {
  return (
    <>
      <div className="mt-sm grid grid-cols-2 gap-xs">
        <label className="text-[12px] text-ink-muted">
          Kind
          <select name="kind" value={form.kind} onChange={(event) => form.setKind(event.target.value as typeof form.kind)} className="mt-xs h-10 w-full rounded-sm border border-border bg-white px-sm text-[13px] text-ink">
            <option value="comp">Comp</option>
            <option value="adjustment">Adjustment</option>
          </select>
        </label>
        <label className="text-[12px] text-ink-muted">
          Unit
          <select name="unit" value={form.unit} onChange={(event) => form.setUnit(event.target.value as typeof form.unit)} className="mt-xs h-10 w-full rounded-sm border border-border bg-white px-sm text-[13px] text-ink">
            <option value="bottles">Bottles</option>
            <option value="ml">ml</option>
          </select>
        </label>
      </div>
      <label className="mt-sm block text-[12px] text-ink-muted">
        Quantity
        <input name="quantity" type="number" step="1" value={form.quantity} onChange={(event) => form.setQuantity(event.target.value)} className="mt-xs h-10 w-full rounded-sm border border-border bg-white px-sm font-mono text-[13px] text-ink" />
      </label>
      <label className="mt-sm block text-[12px] text-ink-muted">
        Reason
        <select name="reason_code_id" value={form.reasonId} onChange={(event) => form.setReasonId(event.target.value)} className="mt-xs h-10 w-full rounded-sm border border-border bg-white px-sm text-[13px] text-ink">
          <option value="">Select a reason</option>
          {reasons.filter((reason) => (form.kind === "comp" ? reason.category === "comp" : reason.category !== "comp")).map((reason) => <option key={reason.id} value={reason.id}>{reason.label}</option>)}
        </select>
      </label>
      <label className="mt-sm block text-[12px] text-ink-muted">
        Note
        <input name="note" maxLength={500} value={form.note} onChange={(event) => form.setNote(event.target.value)} className="mt-xs h-10 w-full rounded-sm border border-border bg-white px-sm text-[13px] text-ink" />
      </label>
      {form.message && <p role="status" className="mt-sm text-[12px] text-ink-muted">{form.message}</p>}
      <button type="button" disabled={form.busy || form.invalid} onClick={form.submit} className="mt-sm h-10 w-full rounded-sm border border-border-strong bg-white text-[13px] font-medium text-ink hover:bg-surface-muted disabled:opacity-50">
        {form.busy ? "Recording…" : "Record event"}
      </button>
    </>
  );
}
