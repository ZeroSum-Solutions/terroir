"use client";

import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { ML_PER_OZ } from "@/lib/units";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import { wineTitle } from "@/lib/wine-display-name";

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
  const [customError, setCustomError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "pour-picker-heading";

  const handleCancel = () => {
    setCustom(null);
    setCustomError(null);
    setNote("");
    onCancel();
  };

  const handleConfirm = (ml: number) => {
    const trimmed = note.trim();
    setCustom(null);
    setCustomError(null);
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
    if (!Number.isFinite(oz) || oz <= 0) {
      setCustomError("Enter a pour greater than 0 oz.");
      return;
    }
    setCustomError(null);
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
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-scrim px-lg"
    >
      <div className="w-full max-w-[420px] rounded-card card-surface p-lg">
        <h2 id={headingId} className="font-serif text-[18px] font-medium text-ink">
          {wineTitle(item.producer, item.name)}
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
                  ? "min-h-11 rounded-pill border-2 border-risk-ink/40 bg-risk-wash text-[14px] font-semibold text-risk-ink hover:bg-risk-wash/70"
                  : "min-h-11 rounded-pill border border-rule bg-surface text-[14px] font-medium text-ink hover:bg-wash"
                }
              >
                {oz} oz
              </button>
            );
          })}
        </div>

        <div className="mt-md flex flex-wrap items-center gap-sm">
          <Field
            id="pour-picker-custom"
            label="Custom (oz)"
            error={customError}
            className="flex flex-wrap items-center gap-sm"
            labelClassName="normal-case tracking-normal"
          >
            {(a11y) => (
              <input
                {...a11y}
                type="number"
                step="0.1"
                min="0.1"
                max="40"
                inputMode="decimal"
                autoFocus
                value={customValue}
                onChange={(e) => {
                  const next = e.target.value;
                  setCustom(next);
                  const oz = Number(next);
                  if (Number.isFinite(oz) && oz > 0) setCustomError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCustom();
                  }
                }}
                placeholder="5.0"
                className="min-h-11 w-[80px] rounded-pill border border-rule bg-surface px-sm text-[14px] outline-none focus:border-accent focus-ring"
              />
            )}
          </Field>
          <button
            type="button"
            disabled={!customValue}
            onClick={submitCustom}
            className="min-h-11 rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover disabled:opacity-40"
          >
            Pour
          </button>
        </div>

        {/* BND-127: Optional note field */}
        <Field
          id="pour-picker-note"
          label="Note (optional)"
          className="mt-md"
          labelClassName="normal-case tracking-normal"
        >
          {(a11y) => (
            <textarea
              {...a11y}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="e.g., comp for VIP"
              className="mt-xs min-h-11 w-full rounded-md border border-rule bg-canvas px-sm py-xs text-[14px] text-ink outline-none focus-visible:border-accent focus-ring"
            />
          )}
        </Field>

        <div className="mt-md flex justify-end">
          <button
            type="button"
            onClick={handleCancel}
            className="min-h-11 rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
