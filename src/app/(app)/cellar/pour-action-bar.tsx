"use client";

import { ChevronDown, PackageOpen, Undo2 } from "lucide-react";
import { ML_PER_OZ } from "@/lib/units";
import { cn } from "@/lib/utils";
import type { CellarWineRow } from "./types";

/**
 * Sticky action bar pinned at the drawer's foot (Undo last pour / Open
 * bottle / Pour). Purely presentational — `doPour` is shared with the
 * PourPickerModal's onConfirm callback in the parent (which renders
 * outside this bar), so the handlers stay owned by the drawer and are
 * threaded in as props rather than re-homed here.
 */
export function PourActionBar({
  row,
  canPour,
  outOfStock,
  pickerItem,
  busy,
  openBottleBusy,
  lastPour,
  doOpenBottle,
  doPour,
  doUndo,
  onOpenPicker,
}: {
  row: CellarWineRow;
  canPour: boolean;
  outOfStock: boolean;
  pickerItem: unknown;
  busy: boolean;
  openBottleBusy: boolean;
  lastPour: { ml: number } | null;
  doOpenBottle: () => void;
  doPour: (ml: number) => void;
  doUndo: () => void;
  onOpenPicker: () => void;
}) {
  return (
    <div
      className="shrink-0 border-t border-rule bg-surface px-md pt-sm md:px-lg"
      style={{ paddingBottom: "calc(var(--safe-bottom) + var(--spacing-sm))" }}
    >
      {/* BND-119: Undo last pour */}
      {lastPour && canPour && (
        <button
          type="button"
          disabled={busy}
          onClick={doUndo}
          className="mb-xs flex h-11 w-full items-center justify-center gap-xs rounded-pill border border-edge bg-surface text-[13px] font-medium text-ink transition-colors hover:bg-wash disabled:opacity-60"
        >
          <Undo2 className="h-4 w-4" strokeWidth={2} aria-hidden />
          Undo last pour ({(lastPour.ml / ML_PER_OZ).toFixed(1)} oz)
        </button>
      )}
      <div className="flex gap-xs">
        {/* BND-121: Manually open a bottle without recording a pour */}
        {row.sealed_count > 0 && (
          <button
            type="button"
            disabled={openBottleBusy}
            onClick={doOpenBottle}
            className={cn(
              "flex h-[52px] flex-1 items-center justify-center gap-xs rounded-pill text-[14px] font-medium transition-colors disabled:opacity-60",
              canPour
                ? "border border-edge bg-surface text-ink hover:bg-wash"
                : "bg-primary text-seal-ink hover:bg-primary-hover",
            )}
          >
            <PackageOpen className="h-4 w-4" strokeWidth={2} aria-hidden />
            {openBottleBusy ? "Opening..." : "Open bottle"}
          </button>
        )}
        {canPour && (
          <>
            <button
              type="button"
              disabled={busy || outOfStock}
              onClick={() => row.glass_pour_ml && doPour(row.glass_pour_ml)}
              className={cn(
                "h-[52px] flex-1 rounded-pill bg-primary text-[15px] font-medium text-seal-ink transition-colors",
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
                onClick={onOpenPicker}
                disabled={busy || outOfStock}
                aria-label="Pick a custom pour size"
                className="flex h-[52px] w-[52px] items-center justify-center rounded-pill border border-rule bg-surface text-grey hover:bg-wash disabled:opacity-60"
              >
                <ChevronDown className="h-5 w-5" strokeWidth={2} aria-hidden />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
