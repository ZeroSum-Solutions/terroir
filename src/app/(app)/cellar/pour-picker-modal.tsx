"use client";

import { useRef, useState } from "react";
import { ML_PER_OZ } from "@/lib/units";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";

type PourItem = OpenBottleRow;

const PRESETS_OZ = [1, 3, 5, 8];

interface Props {
  item: PourItem | null;
  defaultOz?: number;
  onCancel: () => void;
  onConfirm: (ml: number, note?: string) => void;
}

export function PourPickerModal({ item, defaultOz, onCancel, onConfirm }: Props) {
  const [custom, setCustom] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "pour-picker-heading";

  const handleCancel = () => {
    setCustom(null);
    setNote("");
    onCancel();
  };

  const handleConfirm = (ml: number) => {
    const trimmed = note.trim();
    setCustom(null);
    setNote("");
    onConfirm(ml, trimmed.length > 0 ? trimmed : undefined);
  };

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: handleCancel,
    enabled: item !== null,
  });

  if (!item) return null;

  const customValue =
    custom ?? (defaultOz != null && defaultOz > 0 ? String(defaultOz) : "");

  const submitCustom = () => {
    const oz = Number(customValue);
    if (!Number.isFinite(oz) || oz <= 0) return;
    const ml = Math.max(1, Math.round(oz * ML_PER_OZ));
    handleConfirm(ml);
  };

  const defaultMl = defaultOz != null ? Math.round(defaultOz * ML_PER_OZ) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-lg"
    >
      <div className="w-full max-w-[420px] rounded-card border border-hairline bg-white p-lg">
        <h2 id={headingId} className="font-serif text-[18px] font-medium text-ink">
          {item.producer} {item.name}
        </h2>
        <p className="mt-xs text-[12px] text-grey">Pick a pour size</p>

        <div className="mt-md grid grid-cols-2 gap-xs">
          {PRESETS_OZ.map((oz) => {
            const ml = Math.round(oz * ML_PER_OZ);
            const isDefault = defaultMl !== null && ml === defaultMl;
            return (
              <button
                key={oz}
                type="button"
                onClick={() => handleConfirm(ml)}
                className={isDefault
                  ? "h-[48px] rounded-pill border-2 border-primary bg-blush-wash text-[14px] font-semibold text-primary hover:bg-blush-wash/70"
                  : "h-[48px] rounded-pill border border-hairline bg-white text-[14px] font-medium text-ink hover:bg-bridge-surface"
                }
              >
                {oz} oz
              </button>
            );
          })}
        </div>

        <div className="mt-md flex flex-wrap items-center gap-sm">
          <label
            htmlFor="pour-picker-custom"
            className="text-[12px] text-grey"
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
            value={customValue}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCustom();
              }
            }}
            placeholder="5.0"
            className="h-[38px] w-[80px] rounded-pill border border-hairline bg-white px-sm text-[14px] outline-none focus:border-primary focus:ring-2 focus:ring-blush-wash"
          />
          <button
            type="button"
            disabled={!customValue || Number(customValue) <= 0}
            onClick={submitCustom}
            className="h-[38px] rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover disabled:opacity-40"
          >
            Pour
          </button>
        </div>

        {/* BND-127: Optional note field */}
        <div className="mt-md">
          <label
            htmlFor="pour-picker-note"
            className="text-[12px] text-grey"
          >
            Note (optional)
          </label>
          <textarea
            id="pour-picker-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="e.g., comp for VIP"
            className="mt-xs w-full rounded-md border border-hairline bg-canvas px-sm py-xs text-[14px] text-ink outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-blush-wash"
          />
        </div>

        <div className="mt-md flex justify-end">
          <button
            type="button"
            onClick={handleCancel}
            className="h-[38px] rounded-pill border border-ink/25 bg-white px-md text-[13px] font-medium text-ink hover:bg-bridge-surface"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
