"use client";

// The "Recent imports" list under every step — every non-reverted batch for
// this restaurant stays reachable (and revertable) from here. Extracted
// verbatim from import-client.tsx.

import { cn } from "@/lib/utils";
import type { BatchSummary } from "@/domains/import/batch-api-types";

export function RecentImports({
  batches,
  onOpen,
}: {
  batches: BatchSummary[] | null;
  onOpen: (id: string) => void;
}) {
  if (!batches || batches.length === 0) return null;
  return (
    <section className="mt-lg">
      <h2 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">Recent imports</h2>
      {/* Round-27 audit: this used to show only the ten newest, which made
          the in-preview conflict panel the only way to reach an aged-out
          conflicting batch (that panel is now removed — see docs/runbooks/
          csv-import.md). GET /api/import/batches already returns every
          batch for this restaurant, newest first, with no server-side cap
          — showing all of them (rather than adding a new search UI) is the
          smallest change that keeps every non-reverted batch reachable and
          revertable from here. */}
      <ul className="mt-xs space-y-2xs">
        {batches.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onOpen(b.id)}
              className={cn(
                "flex min-h-11 w-full items-center justify-between rounded-card card-surface px-sm text-left text-[13px] text-ink transition-colors hover:bg-wash focus-ring",
              )}
            >
              <span className="truncate">{b.filename}</span>
              <span className="shrink-0 text-caption text-grey">{b.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
