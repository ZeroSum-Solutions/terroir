"use client";

import { useRef, useState } from "react";
import { ML_PER_OZ } from "@/lib/units";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";

// Renamed from PourItem when this file moved into /cellar. Same shape —
// the underlying RPC row shape `list_open_bottle_items` lives in
// @/lib/wine-list/shapes.ts (DEBT-022).
type PourItem = OpenBottleRow;

const PRESETS_OZ = [1, 3, 5, 8];

interface Props {
  item: PourItem | null;
  onCancel: () => void;
  onConfirm: (ml: number) => void;
}

/**
 * BND-038 picker modal. Opens on the picker-caret tap when a wine's
 * pour_size_mode = 'picker'. Four preset oz buttons + a custom numeric
 * input. Matches NoteModal's a11y contract from BND-037:
 * aria-labelledby, Escape to close, focus-trap within the dialog.
 */
export function PourPickerModal({ item, onCancel, onConfirm }: Props) {
  const [custom, setCustom] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "pour-picker-heading";

  const handleCancel = () => {
    setCustom("");
    onCancel();
  };

  const handleConfirm = (ml: number) => {
    setCustom("");
    onConfirm(ml);
  };

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: onCancel,
    enabled: item !== null,
  });

  if (!item) return null;

  const submitCustom = () => {
    const oz = Number(custom);
    if (!Number.isFinite(oz) || oz <= 0) return;
    const ml = Math.max(1, Math.round(oz * ML_PER_OZ));
    handleConfirm(ml);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-lg"
    >
      <div className="w-full max-w-[420px] rounded-md border border-border bg-white p-lg shadow-lg">
        <h2 id={headingId} className="font-serif text-[18px] text-ink">
          {item.producer} {item.name}
        </h2>
        <p className="mt-xs text-[12px] text-ink-muted">Pick a pour size</p>

        <div className="mt-md grid grid-cols-2 gap-xs">
          {PRESETS_OZ.map((oz) => (
            <button
              key={oz}
              type="button"
              onClick={() => handleConfirm(Math.round(oz * ML_PER_OZ))}
              className="h-[48px] rounded-sm border border-border bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
            >
              {oz} oz
            </button>
          ))}
        </div>

        <div className="mt-md flex flex-wrap items-center gap-sm">
          <label
            htmlFor="pour-picker-custom"
            className="text-[12px] text-ink-muted"
          >
            Custom (oz)
          </label>
          <input
            id="pour-picker-custom"
            type="number"
            step="0.1"
            min="0.1"
            max="40"
            inputMode="decimal"
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCustom();
              }
            }}
            placeholder="5.0"
            className="h-[38px] w-[80px] rounded-sm border border-border bg-white px-sm text-[14px] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
          />
          <button
            type="button"
            disabled={!custom || Number(custom) <= 0}
            onClick={submitCustom}
            className="h-[38px] rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
          >
            Pour
          </button>
        </div>

        <div className="mt-md flex justify-end">
          <button
            type="button"
            onClick={handleCancel}
            className="h-[38px] rounded-sm border border-border bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
