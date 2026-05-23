"use client";

import { useRef, useState, useEffect } from "react";
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
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "pour-picker-heading";

  useEffect(() => {
    if (defaultOz != null && defaultOz > 0 && !custom) {
      setCustom(String(defaultOz));
    }
  }, [defaultOz]);

  const handleCancel = () => {
    setCustom("");
    setNote("");
    onCancel();
  };

  const handleConfirm = (ml: number) => {
    const trimmed = note.trim();
    setCustom("");
    setNote("");
    onConfirm(ml, trimmed.length > 0 ? trimmed : undefined);
  };

  useFocusTrap({
    containerRef: dialogRef,
    onEscape: handleCancel,
    enabled: item !== null,
  });

  if (!item) return null;

  const submitCustom = () => {
    const oz = Number(custom);
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
      <div className="w-full max-w-[420px] rounded-md border border-border bg-white p-lg shadow-lg">
        <h2 id={headingId} className="font-serif text-[18px] text-ink">
          {item.producer} {item.name}
        </h2>
        <p className="mt-xs text-[12px] text-ink-muted">Pick a pour size</p>

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
                  ? "h-[48px] rounded-sm border-2 border-accent bg-accent-soft text-[14px] font-semibold text-accent hover:bg-accent-soft/70"
                  : "h-[48px] rounded-sm border border-border bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
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

        {/* BND-127: Optional note field */}
        <div className="mt-md">
          <label
            htmlFor="pour-picker-note"
            className="text-[12px] text-ink-muted"
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
            className="mt-xs w-full rounded-sm border border-border bg-surface px-sm py-xs text-[14px] text-ink outline-none focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent-soft"
          />
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
