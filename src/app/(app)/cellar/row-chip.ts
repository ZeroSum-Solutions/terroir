import { ML_PER_OZ } from "@/lib/units";
import {
  getDrinkWindowStatus,
  getYearsUntilWindowClose,
} from "@/lib/drink-window/status";
import type { WaxTone } from "@/components/status-chip";

/**
 * One chip per cellar row (Kimi audit 2026-08-26, row anatomy). The old
 * rows triple-encoded status — stock chip + low chip + duplicate chip +
 * drink-window chip could all render at once. This picks the single most
 * urgent fact; everything else lives in the quantity column, the bin
 * column, and the drawer.
 *
 * Priority (most urgent wins):
 *   86'd → past peak → low stock → drink now → possible duplicate →
 *   open bottle → optimal window → no stock → (quiet row: no chip)
 */
export type RowChip = { label: string; tone: WaxTone };

export function pickRowChip(
  row: {
    is_eightysixed: boolean;
    sealed_count: number;
    size_ml: number | null;
    open_remaining_ml: number | null;
    drink_window_start: number | null;
    drink_window_end: number | null;
    duplicate_wine_ids: string[];
  },
  lowStockThreshold?: number,
  currentYear: number = new Date().getFullYear(),
): RowChip | null {
  if (row.is_eightysixed) return { label: "86'd", tone: "urgent" };

  const status = getDrinkWindowStatus(
    row.drink_window_start,
    row.drink_window_end,
    currentYear,
  );
  if (status === "past_peak") return { label: "Past peak", tone: "urgent" };

  const isLowStock =
    lowStockThreshold != null &&
    row.sealed_count > 0 &&
    row.sealed_count < lowStockThreshold;
  if (isLowStock) return { label: "Low stock", tone: "attention" };

  if (status === "drink_now") {
    const yearsLeft = getYearsUntilWindowClose(row.drink_window_end, currentYear);
    return {
      label: yearsLeft === 0 ? "Final year" : "Drink now",
      tone: "attention",
    };
  }

  if (row.duplicate_wine_ids.length > 0) {
    return { label: "Duplicate?", tone: "neutral" };
  }

  const isOpen = row.open_remaining_ml !== null && row.open_remaining_ml > 0;
  if (isOpen) {
    const oz = (row.open_remaining_ml! / ML_PER_OZ).toFixed(1);
    return { label: `Open · ${oz} oz`, tone: "neutral" };
  }

  if (status === "optimal") return { label: "Peak", tone: "optimal" };

  if (row.sealed_count === 0) return { label: "No stock", tone: "muted" };

  return null;
}

/** Bottles on hand: sealed plus the open bottle, when one exists. */
export function bottlesOnHand(row: {
  sealed_count: number;
  open_remaining_ml: number | null;
}): number {
  const open = row.open_remaining_ml !== null && row.open_remaining_ml > 0 ? 1 : 0;
  return row.sealed_count + open;
}
