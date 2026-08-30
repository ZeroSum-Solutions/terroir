"use client";

// The preview's two LWIN bands — "Matched wines" (rows that will actually
// link, with a reject toggle) and "Below match threshold" (rows apply will
// never stamp, shown honestly with no control) — and the row items inside
// them. Extracted verbatim from import-client.tsx; PreviewStep still owns
// both disclosure counts and the rejection set.

import type { Dispatch, SetStateAction } from "react";
import { LWIN_APPLY_MIN_SCORE } from "@/domains/import/constants";
import type { MatchedLwinRowEntry, RejectedLwinRows } from "@/domains/import/review-types";

// Item 2 (per-row LWIN match visibility): same incremental-disclosure
// pattern as MAX_SHOWN_ERROR_ROWS above, for the "Matched wines" section —
// at PR #133's measured 77% match rate, a file at the MAX_ROWS (5000)
// ceiling can have thousands of matched rows, which would otherwise render
// unbounded.
export const MAX_SHOWN_MATCHED_ROWS = 100;

export function PreviewMatchedWines({
  shownMatchedRows,
  linkingMatchedRows,
  hiddenMatchedCount,
  effectiveRejectedLwinRows,
  onToggleLwinReject,
  isRowLocked,
  isRowSkipped,
  confirming,
  setShownMatchedCount,
}: {
  shownMatchedRows: MatchedLwinRowEntry[];
  linkingMatchedRows: MatchedLwinRowEntry[];
  hiddenMatchedCount: number;
  effectiveRejectedLwinRows: RejectedLwinRows;
  onToggleLwinReject?: (rowNumber: number) => void;
  isRowLocked: (rowNumber: number) => boolean;
  isRowSkipped?: (rowNumber: number) => boolean;
  confirming: boolean;
  setShownMatchedCount: Dispatch<SetStateAction<number>>;
}) {
  if (shownMatchedRows.length === 0) return null;
  return (
    <div className="mt-lg">
      <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
        Matched wines ({linkingMatchedRows.length})
      </h3>
      <p className="mt-2xs text-caption text-grey">
        Each row below matched a wine in the catalog and will link it on import — reject a match you
        don&rsquo;t trust and it imports with no catalog link, exactly like a row that never matched.
      </p>
      <ul className="mt-xs space-y-2xs">
        {shownMatchedRows.map((row) => (
          <MatchedLwinRowItem
            key={row.rowNumber}
            row={row}
            rejected={effectiveRejectedLwinRows.has(row.rowNumber)}
            onToggle={onToggleLwinReject ?? (() => {})}
            // Same PERMANENT lock as RowFixItem's own `locked` — a row
            // whose chunk is already confirmed can never be resent, so
            // a reject click here would silently go nowhere (Sol
            // round-2 audit finding 1's exact reasoning, applied to
            // this new control).
            locked={isRowLocked(row.rowNumber)}
            skipped={isRowSkipped?.(row.rowNumber) ?? false}
            frozen={confirming}
          />
        ))}
      </ul>
      {hiddenMatchedCount > 0 && (
        <button
          type="button"
          onClick={() => setShownMatchedCount((count) => count + MAX_SHOWN_MATCHED_ROWS)}
          className="mt-xs min-h-11 rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink transition-colors hover:bg-wash focus-ring"
        >
          Show {Math.min(hiddenMatchedCount, MAX_SHOWN_MATCHED_ROWS)} more matched row(s)
        </button>
      )}
    </div>
  );
}

/** BLOCK 3 (Sol audit round 3, finding 3): a candidate scoring below
 * LWIN_APPLY_MIN_SCORE is never stamped by apply regardless of operator
 * action (0108's own lwin_score >= LWIN_APPLY_MIN_SCORE gate) — shown
 * honestly, in its own band, with NO reject control: rejecting something
 * that was never going to be applied is meaningless (this brief's own
 * wording). */
export function PreviewBelowThreshold({
  shownBelowThresholdRows,
  belowThresholdMatchedRows,
  hiddenBelowThresholdCount,
  setShownBelowThresholdCount,
}: {
  shownBelowThresholdRows: MatchedLwinRowEntry[];
  belowThresholdMatchedRows: MatchedLwinRowEntry[];
  hiddenBelowThresholdCount: number;
  setShownBelowThresholdCount: Dispatch<SetStateAction<number>>;
}) {
  if (shownBelowThresholdRows.length === 0) return null;
  return (
    <div className="mt-lg">
      <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
        Below match threshold ({belowThresholdMatchedRows.length})
      </h3>
      <p className="mt-2xs text-caption text-grey">
        These scored below the {LWIN_APPLY_MIN_SCORE.toFixed(2)} confidence bar apply requires to link a
        catalog entry — they&rsquo;ll import with no wine-catalog link no matter what you do here.
      </p>
      <ul className="mt-xs space-y-2xs">
        {shownBelowThresholdRows.map((row) => (
          <BelowThresholdLwinRowItem key={row.rowNumber} row={row} />
        ))}
      </ul>
      {hiddenBelowThresholdCount > 0 && (
        <button
          type="button"
          onClick={() => setShownBelowThresholdCount((count) => count + MAX_SHOWN_MATCHED_ROWS)}
          className="mt-xs min-h-11 rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink transition-colors hover:bg-wash focus-ring"
        >
          Show {Math.min(hiddenBelowThresholdCount, MAX_SHOWN_MATCHED_ROWS)} more row(s)
        </button>
      )}
    </div>
  );
}

/** Item 2 (per-row LWIN match visibility) — one matched row: the catalog's
 * own display name and match score, with a reject toggle. Rejecting is a
 * simple client-side flag, round-tripped through the SAME reject/accept
 * pair on every render (never a one-way action) — an operator can change
 * their mind right up until confirm, exactly like an inline row-fix edit
 * can. The label mirrors RowFixItem's own "Chunk N, data row M" vs
 * "Row N" convention (see its own comment). */
function MatchedLwinRowItem({
  row,
  rejected,
  onToggle,
  locked,
  skipped,
  frozen,
}: {
  row: MatchedLwinRowEntry;
  rejected: boolean;
  onToggle: (rowNumber: number) => void;
  /** Sol round-2 audit finding 1's reasoning, applied to this new control:
   * a row whose chunk is already CONFIRMED can never be resent, so a
   * reject click here would silently go nowhere — disabled with the same
   * explanatory copy RowFixItem uses. Always false on the plain
   * (non-chunked) path. */
  locked: boolean;
  /** Round-6 audit finding 5's counterpart — a row belonging to a
   * client-side skipped chunk, same reasoning as `locked`. */
  skipped: boolean;
  /** Same TEMPORARY in-flight freeze RowFixItem's own `frozen` prop
   * applies — a reject/undo click while a confirm attempt is already
   * dispatching this row's rejection state would otherwise be silently
   * overwritten by that attempt's own snapshot. */
  frozen: boolean;
}) {
  const disabled = locked || skipped || frozen;
  const label = row.chunkIndex !== undefined && row.chunkRowNumber !== undefined
    ? `Chunk ${row.chunkIndex}, data row ${row.chunkRowNumber}`
    : `Row ${row.rowNumber}`;
  return (
    <li className="rounded-md bg-wash px-sm py-xs text-[13px] text-ink">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div>
          <span>{label}</span>
          <p className="mt-2xs text-caption text-grey">
            {locked
              ? "Row already imported with this chunk — revert the import to change it."
              : skipped
                ? "Row belongs to a skipped chunk."
                : rejected
                  ? "Match rejected — will import with no wine-catalog link, same as an unmatched row."
                  : `${row.lwinDisplayName ?? "Catalog entry (name unavailable)"} — match score ${row.lwinScore.toFixed(2)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onToggle(row.rowNumber)}
          disabled={disabled}
          className="min-h-11 rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {rejected ? "Undo reject" : "Reject match"}
        </button>
      </div>
    </li>
  );
}

/** BLOCK 3 (Sol audit round 3, finding 3) — one below-apply-threshold
 * candidate: the catalog's own display name and match score, exactly like
 * MatchedLwinRowItem's own display line, but deliberately with NO reject
 * control — apply's own lwin_score >= LWIN_APPLY_MIN_SCORE gate (0108)
 * already guarantees this row imports with no wine-catalog link, so a
 * reject toggle here would be a control that changes nothing. */
function BelowThresholdLwinRowItem({ row }: { row: MatchedLwinRowEntry }) {
  const label = row.chunkIndex !== undefined && row.chunkRowNumber !== undefined
    ? `Chunk ${row.chunkIndex}, data row ${row.chunkRowNumber}`
    : `Row ${row.rowNumber}`;
  return (
    <li className="rounded-md bg-wash px-sm py-xs text-[13px] text-ink">
      <span>{label}</span>
      <p className="mt-2xs text-caption text-grey">
        {row.lwinDisplayName ?? "Catalog entry (name unavailable)"} — match score {row.lwinScore.toFixed(2)}, will
        import with no catalog link.
      </p>
    </li>
  );
}
