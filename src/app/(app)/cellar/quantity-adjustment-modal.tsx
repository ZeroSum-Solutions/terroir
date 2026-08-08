"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
} from "@/lib/api/idempotency-client";
import { useToast } from "@/lib/toast";

const quantityCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence("terroir:cellar-quantity"),
});

export function QuantityAdjustmentModal({
  wineId,
  wineName,
  currentQuantity,
  onClose,
}: {
  wineId: string;
  wineName: string;
  currentQuantity: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const [quantity, setQuantity] = useState(String(currentQuantity));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusTrap({ containerRef: dialogRef, onEscape: onClose, enabled: true });

  const parsedQuantity = Number(quantity);
  const valid =
    Number.isInteger(parsedQuantity) &&
    parsedQuantity >= 0 &&
    parsedQuantity <= 100000 &&
    reason.trim().length > 0 &&
    reason.trim().length <= 500;

  async function submit() {
    if (!valid || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { response, data } = await quantityCommands.json<unknown>({
        slot: `quantity:${wineId}`,
        url: `/api/cellar/${wineId}/quantity`,
        method: "PATCH",
        json: { quantity: parsedQuantity, reason: reason.trim() },
      });
      if (!response.ok) {
        throw new Error(
          readApiError(data, `Adjustment failed (${response.status}).`).message,
        );
      }
      toast.success(
        parsedQuantity === currentQuantity
          ? "Quantity confirmed"
          : "Quantity adjusted and logged",
      );
      onClose();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Adjustment failed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end bg-black/25 md:items-center md:justify-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quantity-adjustment-heading"
        className="w-full rounded-t-lg bg-surface shadow-xl md:w-[440px] md:rounded-lg"
      >
        <header className="flex items-center justify-between border-b border-border px-md py-sm">
          <div>
            <h2 id="quantity-adjustment-heading" className="text-[15px] font-semibold text-ink">
              Adjust quantity
            </h2>
            <p className="mt-2xs text-[12px] text-ink-muted">{wineName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close quantity adjustment" className="flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>
        <div className="space-y-md p-md">
          <label className="block text-[12px] font-medium text-ink-muted">
            Current sealed quantity
            <input
              type="number"
              min={0}
              max={100000}
              step={1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className="mt-xs h-10 w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink"
            />
          </label>
          <label className="block text-[12px] font-medium text-ink-muted">
            Reason
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Physical count, damaged bottle, transfer…"
              className="mt-xs w-full rounded-sm border border-border bg-white p-sm text-[14px] text-ink"
            />
          </label>
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          <button
            type="button"
            disabled={!valid || busy}
            onClick={submit}
            className="h-11 w-full rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save audited adjustment"}
          </button>
        </div>
      </div>
    </div>
  );
}
