"use client";

import type { CellarWineRow } from "./types";

/**
 * BND-070 — DecantTimeSection. Shows recommended decant time
 * when enrichment has set it and it's > 0 minutes.
 */
export function DecantTimeSection({ row }: { row: CellarWineRow }) {
  const hours = row.decant_minutes! >= 60
    ? Math.floor(row.decant_minutes! / 60)
    : 0;
  const mins = row.decant_minutes! % 60;

  let display: string;
  if (hours > 0 && mins > 0) {
    display = hours + "h " + mins + "m";
  } else if (hours > 0) {
    display = hours + " hour" + (hours === 1 ? "" : "s");
  } else {
    display = mins + " min";
  }

  return (
    <section
      aria-label="Decant time"
      className="mt-md rounded-lg card-surface p-md"
    >
      <h3 className="text-caption font-medium uppercase text-grey mb-xs">Decant time</h3>
      <p className="text-[14px] text-ink-soft">
        {display}
      </p>
    </section>
  );
}
