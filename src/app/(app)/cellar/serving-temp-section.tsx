"use client";

import type { CellarWineRow } from "./types";

/**
 * BND-069 — ServingTempSection. Shows recommended serving temperature
 * when enrichment has set it.
 */
export function ServingTempSection({ row }: { row: CellarWineRow }) {
  return (
    <section
      aria-label="Serving temperature"
      className="mt-md rounded-lg card-surface p-md"
    >
      <h3 className="text-caption font-medium uppercase text-grey mb-xs">Serving temperature</h3>
      <p className="text-[14px] text-ink-soft">
        {row.serving_temp_min}–{row.serving_temp_max}°F
      </p>
      {row.serving_temp_label && (
        <p className="mt-2xs text-[12px] text-grey">{row.serving_temp_label}</p>
      )}
    </section>
  );
}
