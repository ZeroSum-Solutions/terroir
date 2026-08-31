"use client";

import { useRouter } from "next/navigation";
import { buildQuery, STATUS_FILTERS, type StatusFilter } from "./scan-list-status";

/**
 * GLOBAL-01 — the scan-history scope control, as ONE control.
 *
 * This was four `flex-wrap` pills carrying a label and a count. Measured on the
 * running app at 390px (e2e/one-row-rule.test.ts): All 65px, Complete 101px,
 * Processing 107px, Failed 82px — 355px of pill plus 24px of gaps against 354px
 * of usable row, so "Failed" wrapped onto a second visual line (three chips at
 * y=275, the fourth at y=327). One `flex-wrap` element, one source row, two rows
 * to the eye — which is the count Devin's rule is written about, and the shape
 * `scripts/check-control-rows.mjs` says in its own header it cannot see.
 *
 * The fix is `src/app/(app)/cellar/cellar-counters.tsx`'s, for the same reason:
 * the strip's width is DATA-dependent — every count is a live number and
 * "Processing" gets wider the moment it reads 1,024 — so no breakpoint can be
 * right. A `<select>` is constant-width whatever the data, and it is the rule's
 * own answer: four controls becoming one.
 *
 * Nothing is lost. Each option still carries its count, and the active filter is
 * on screen at all times, which is all the pills showed.
 */
export function ScanStatusSelect({
  status,
  counts,
}: {
  status: StatusFilter;
  counts: Record<Exclude<StatusFilter, "all">, number>;
}) {
  const router = useRouter();
  const total = counts.complete + counts.processing + counts.failed;

  return (
    <div data-scan-filter-row className="mt-md flex items-center gap-xs">
      <select
        aria-label="Filter scans by status"
        value={status}
        onChange={(event) => {
          router.push(`/scans${buildQuery({ status: event.target.value as StatusFilter })}`);
        }}
        className="h-11 min-w-0 flex-1 truncate rounded-pill border border-edge bg-surface px-sm text-body-sm font-medium text-ink hover:bg-wash focus-ring sm:max-w-[240px]"
      >
        {STATUS_FILTERS.map((filter) => (
          <option key={filter.value} value={filter.value}>
            {filter.label} · {filter.value === "all" ? total : counts[filter.value]}
          </option>
        ))}
      </select>
    </div>
  );
}
