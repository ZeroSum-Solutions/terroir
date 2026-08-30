"use client";

import { DrinkWindowTimeline } from "@/components/drink-window-timeline";
import {
  formatStatusLabel,
  getDrinkWindowStatus,
  getYearsUntilWindowClose,
  getYearsUntilWindowOpen,
} from "@/lib/drink-window/status";
import { StatusChip, type WaxTone } from "@/components/status-chip";
import type { CellarWineRow } from "./types";

/**
 * BND-039 + BND-071 — DrinkWindowSection. Renders the timeline + status
 * pill + critic citation + start/peak/end year labels for wines that have
 * been enriched with drink-window data.
 */
export function DrinkWindowSection({ row }: { row: CellarWineRow }) {
  const status = getDrinkWindowStatus(row.drink_window_start, row.drink_window_end);
  const yearsLeft = getYearsUntilWindowClose(row.drink_window_end);
  const yearsUntilOpen = getYearsUntilWindowOpen(row.drink_window_start);

  // BND-071 — status on the Wax & Counter urgency scale (DESIGN.md
  // 2026-08-26): quiet hold, gold optimal, burgundy steps for the rest.
  const pillTone: WaxTone = (() => {
    switch (status) {
      case "optimal":
        return "optimal";
      case "drink_now":
        return "attention";
      case "past_peak":
        return "urgent";
      case "hold":
      default:
        return "muted";
    }
  })();

  return (
    <section
      aria-label="Drink window"
      className="mt-md rounded-lg card-surface p-md"
    >
      <h3 className="text-caption font-medium uppercase text-grey mb-sm">Drink window</h3>

      {/* One axis only: the timeline renders start / peak / end itself, with
          the peak label at its true position — a second flex-spaced row here
          put "Peak 2017" over a conflicting midpoint tick (Kimi audit). */}
      <DrinkWindowTimeline
        start={row.drink_window_start as number}
        end={row.drink_window_end as number}
        peak={row.peak_year as number | undefined}
      />

      <div className="mt-sm flex items-center justify-between text-[12px]">
        {/* BND-071 — status pill, Wax & Counter mapping. */}
        <StatusChip tone={pillTone}>
          {formatStatusLabel(status, yearsLeft, yearsUntilOpen)}
        </StatusChip>
        {yearsLeft !== null && (
          <span className="text-grey">
            {yearsLeft >= 0
              ? `${yearsLeft} year${yearsLeft === 1 ? "" : "s"} left`
              : `${Math.abs(yearsLeft)} year${Math.abs(yearsLeft) === 1 ? "" : "s"} past`}
          </span>
        )}
      </div>

      {row.review_excerpt && (
        <blockquote className="mt-sm border-l-2 border-risk-wash pl-sm text-[12px] text-grey italic leading-relaxed">
          {row.review_excerpt}
          {row.rating && row.rating_source && (
            <cite className="mt-2xs block not-italic font-medium text-grey">
              {row.rating} pts — {row.rating_source}
            </cite>
          )}
        </blockquote>
      )}
    </section>
  );
}
