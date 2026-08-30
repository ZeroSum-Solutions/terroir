"use client";

// The preview step: the summary tiles, the chunk breakdown, the three
// row-disclosure bands (delegated to preview-error-rows.tsx and
// preview-lwin-rows.tsx), per-chunk upload progress, and the Confirm/Retry
// gate. Extracted verbatim from import-client.tsx, which still owns every
// piece of state behind it and re-exports PreviewStep unchanged.

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { CLIENT_CHUNK_TARGET_ROWS, LWIN_APPLY_MIN_SCORE, type CanonicalHeader } from "@/domains/import/constants";
import type { PreviewSummary } from "@/domains/import/preview-service";
import type { ChunkUploadState } from "@/domains/import/chunked-upload-types";
import type {
  ErrorRowEntry,
  MatchedLwinRowEntry,
  RejectedLwinRows,
  RowOverrides,
} from "@/domains/import/review-types";
import { computeUnresolvedDuplicateChunkContentIndexes } from "@/domains/import/duplicate-chunk-retry";
import { computePreviewCounts } from "@/domains/import/preview-counts";
import { describeWaitEstimate, estimateChunkedPhaseWaitSeconds } from "@/domains/import/wait-estimate";
import { ChunkUploadProgress } from "./chunk-upload-progress";
import { MAX_SHOWN_ERROR_ROWS, PreviewErrorRows } from "./preview-error-rows";
import { MAX_SHOWN_MATCHED_ROWS, PreviewBelowThreshold, PreviewMatchedWines } from "./preview-lwin-rows";
import { SummaryStat } from "./summary-stat";

// Stable empty defaults for PreviewStep's optional matchedRows/
// rejectedLwinRows props — module-level so every render that omits them
// (every pre-existing caller) reuses the SAME reference rather than
// allocating a fresh empty array/Set every render.
const EMPTY_MATCHED_ROWS: MatchedLwinRowEntry[] = [];
const EMPTY_REJECTED_LWIN_ROWS: RejectedLwinRows = new Set();

/** Renders either the plain (<= MAX_ROWS) preview or the aggregated,
 * chunked (> MAX_ROWS) preview — chunkBreakdown/chunkTotal/chunkUpload are
 * only ever set for the latter. Exported so it can be pinned directly by
 * import-client.test.tsx (locked-row rendering, the honest chunk/data-row
 * label, incremental error-row disclosure, and the chunk_content_mismatch
 * terminal state — Sol round-2 audit findings 1, 3, 4, 5). */
export function PreviewStep({
  filename,
  summary,
  errorRows,
  matchedRows,
  rejectedLwinRows,
  onToggleLwinReject,
  rowOverrides,
  onRowFieldChange,
  isRowLocked,
  isRowSkipped,
  chunkBreakdown,
  chunkTotal,
  chunkUpload,
  onSkipChunk,
  onImportAnyway,
  onUndoSkip,
  onConfirm,
  confirming,
  onBack,
  error,
}: {
  filename: string;
  summary: PreviewSummary;
  errorRows: ErrorRowEntry[];
  /** Item 2 (per-row LWIN match visibility): every matched row, so the
   * operator can see WHAT matched (not just that it did) and reject a
   * match they don't trust. Optional (defaults to none shown) so every
   * pre-existing caller/test that doesn't know about this feature keeps
   * working unchanged — mirrors isRowSkipped's own optionality above. */
  matchedRows?: MatchedLwinRowEntry[];
  rejectedLwinRows?: RejectedLwinRows;
  onToggleLwinReject?: (rowNumber: number) => void;
  rowOverrides: RowOverrides;
  onRowFieldChange: (rowNumber: number, field: CanonicalHeader, value: string) => void;
  /** Sol round-2 audit finding 1: true for a row whose chunk is already
   * confirmed — its inline-fix inputs render read-only. Always returns
   * false on the plain (non-chunked) path. */
  isRowLocked: (rowNumber: number) => boolean;
  /** Round-6 audit finding 5: true for a row whose chunk has been
   * client-side skipped — see isRowInSkippedChunk's own comment. Optional
   * (defaults to "never skipped") so every pre-existing caller/test that
   * doesn't know about skip keeps working unchanged. */
  isRowSkipped?: (rowNumber: number) => boolean;
  chunkBreakdown?: { index: number; startRow: number; endRow: number; summary: PreviewSummary }[];
  chunkTotal?: number;
  chunkUpload: ChunkUploadState[] | null;
  /** Round-5 audit finding 4: "Skip this chunk" for a duplicate_chunk_content
   * chunk — see ChunkUploadProgress's own comment. Omitted on the plain
   * (non-chunked) path, where the concept doesn't apply. */
  onSkipChunk?: (index: number) => void;
  /** Round-6 audit finding 3: "Import anyway" for a duplicate_chunk_content
   * chunk — see ChunkUploadProgress's own comment. Omitted on the plain
   * (non-chunked) path. */
  onImportAnyway?: (index: number) => void;
  /** Round-6 audit finding 5: restores a skipped chunk to its failed
   * duplicate_chunk_content state, with both actions available again.
   * Omitted on the plain (non-chunked) path. */
  onUndoSkip?: (index: number) => void;
  onConfirm: () => void;
  confirming: boolean;
  onBack: () => void;
  /** The server's own message for the most recent failure — including a
   * multiple_live_batches or duplicate_race_retry conflict. This is the
   * ONLY guidance this panel shows for a conflict (round-27 audit — see
   * docs/runbooks/csv-import.md): no separate standing instruction, no
   * client-invented terminal state. Recovery for multiple_live_batches is
   * through Recent imports, which lists every non-reverted batch. */
  error: string | null;
}) {
  // Sol round-2 audit (2026-08-27) finding 4: incremental disclosure
  // instead of a hard cap — starts at MAX_SHOWN_ERROR_ROWS and grows by
  // the same page size each time "Show more" is clicked, repeatable
  // until every error row is shown. Safe as plain useState: PreviewStep
  // unmounts (step leaves "preview") before a genuinely new errorRows
  // list can ever replace this one, so there's no stale-count case to
  // reset for.
  const [shownCount, setShownCount] = useState(MAX_SHOWN_ERROR_ROWS);
  // Item 2: same incremental-disclosure pattern, for matchedRows.
  const effectiveMatchedRows = matchedRows ?? EMPTY_MATCHED_ROWS;
  const effectiveRejectedLwinRows = rejectedLwinRows ?? EMPTY_REJECTED_LWIN_ROWS;
  // BLOCK 3 (Sol audit round 3, finding 3): preview classifies a match at
  // score >= LWIN_MATCH_THRESHOLD (0.3, constants.ts), but apply only
  // stamps wines.lwin_id at score >= LWIN_APPLY_MIN_SCORE (0.6,
  // 0108_apply_import_batch_chunk_v2.sql) — a row below that bar imports
  // with no catalog link no matter what the operator does with it. Split
  // here so "Matched wines" only ever claims rows that will actually
  // link, and a sub-threshold candidate gets its own honestly-labeled band
  // instead of a reject control that would do nothing.
  //
  // BLOCK 2 (round-13 fix) — an apply-eligible row (score >=
  // LWIN_APPLY_MIN_SCORE) with no display identity (lwinDisplayName ===
  // null) is EXCLUDED from linkingMatchedRows too, not just from
  // buildApprovedLwinRows' own payload: the operator can't verify a match
  // they're never shown, so it's treated as not-shown entirely — it never
  // renders under "Matched wines" (would wrongly imply it links) and never
  // renders under "Below match threshold" either (its score genuinely
  // clears that bar, so that band's own copy — "will import with no
  // catalog link" — would be a lie). Same condition buildApprovedLwinRows
  // gates on, so a row that isn't shown here is never approved either.
  const linkingMatchedRows = effectiveMatchedRows.filter(
    (r) => r.lwinScore >= LWIN_APPLY_MIN_SCORE && r.lwinDisplayName !== null,
  );
  const belowThresholdMatchedRows = effectiveMatchedRows.filter((r) => r.lwinScore < LWIN_APPLY_MIN_SCORE);
  const [shownMatchedCount, setShownMatchedCount] = useState(MAX_SHOWN_MATCHED_ROWS);
  const shownMatchedRows = linkingMatchedRows.slice(0, shownMatchedCount);
  const hiddenMatchedCount = linkingMatchedRows.length - shownMatchedRows.length;
  const [shownBelowThresholdCount, setShownBelowThresholdCount] = useState(MAX_SHOWN_MATCHED_ROWS);
  const shownBelowThresholdRows = belowThresholdMatchedRows.slice(0, shownBelowThresholdCount);
  const hiddenBelowThresholdCount = belowThresholdMatchedRows.length - shownBelowThresholdRows.length;
  const shownErrorRows = errorRows.slice(0, shownCount);
  const hiddenCount = errorRows.length - shownErrorRows.length;
  // The honest client-side projection of what will actually import — the
  // operator's inline fixes counted in, a skipped chunk's rows counted out.
  // See computePreviewCounts (preview-counts.ts) for the full reasoning.
  const { fixedCount, canConfirm, effectivePassingValidationRows, effectiveErrorRows } = computePreviewCounts({
    summary,
    errorRows,
    rowOverrides,
    isRowSkipped,
    chunkUpload,
    chunkBreakdown,
  });
  const hasFailedChunk = chunkUpload?.some((c) => c.status === "failed") ?? false;
  // Sol round-2 audit finding 3: chunk_content_mismatch is TERMINAL —
  // retrying re-sends this exact chunk's content and fails the same way
  // every time, and there is no fix reachable from inside this UI (the
  // conflict is with a DIFFERENT already-confirmed chunk, resolved only by
  // reverting it elsewhere). Never offer "Retry upload" for it; the
  // server's own message (surfaced via `error` above) already explains
  // the revert path.
  const hasChunkContentMismatch = chunkUpload?.some((c) => c.status === "failed" && c.code === "chunk_content_mismatch") ?? false;
  // Round-27 audit (removes the in-preview conflict-recovery panel, which
  // failed five straight audits — see docs/runbooks/csv-import.md):
  // multiple_live_batches and duplicate_race_retry no longer block
  // Confirm/Retry, and neither invents a terminal state after repeated
  // attempts. The server re-evaluates on every confirm attempt regardless
  // of what happened before, so a retry that changes nothing simply
  // re-raises the same conflict with fresh data, harmless and repeatable —
  // recovery for multiple_live_batches is through Recent imports, which no
  // longer hides an aged-out batch. Only chunk_content_mismatch and
  // duplicate_chunk_content stay terminal here — both have no fix a blind
  // retry could ever produce, unlike these two.
  // Round-4 audit finding 2: duplicate_chunk_content is also terminal by
  // default — no "Retry upload" — since a blind retry re-sends the exact
  // same bytes and 23505s the same way every time. UNLIKE
  // chunk_content_mismatch, though, it has a real fix reachable from
  // inside this same UI, so the gate is "has anything the digest folds in
  // actually CHANGED since the failed attempt" —
  // computeUnresolvedDuplicateChunkContentIndexes (duplicate-chunk-retry.ts)
  // carries the full reasoning and the three slice comparisons.
  const unresolvedDuplicateChunkContentIndexes = computeUnresolvedDuplicateChunkContentIndexes({
    chunkUpload,
    chunkBreakdown,
    rowOverrides,
    rejectedLwinRows: effectiveRejectedLwinRows,
    matchedRows: effectiveMatchedRows,
  });
  const hasUnresolvedDuplicateChunkContent = unresolvedDuplicateChunkContentIndexes.size > 0;
  const blocksConfirmButton = hasChunkContentMismatch || hasUnresolvedDuplicateChunkContent;

  return (
    <div className="rounded-card card-surface p-lg">
      <h2 className="font-serif text-[20px] text-ink">Preview: {filename}</h2>
      {chunkTotal !== undefined ? (
        <p className="mt-2xs text-[13px] text-grey">
          This file will be split into {chunkTotal} chunk{chunkTotal === 1 ? "" : "s"} of up to{" "}
          {CLIENT_CHUNK_TARGET_ROWS} rows, uploaded one at a time under a single import session.{" "}
          {/* BLOCK 1 (round-11 fix, was WARN 4 round-29 audit): each chunk
              passing its own per-chunk time budget says nothing about the
              total wait for a multi-chunk file — stated honestly here,
              before the operator clicks Confirm and starts the (also
              sequential, also per-chunk-bounded) confirm phase. */}
          Confirming it is estimated to take up to{" "}
          {describeWaitEstimate(estimateChunkedPhaseWaitSeconds(chunkTotal))}, the same as preview.
        </p>
      ) : (
        // BLOCK 1 (round-11 fix): the plain (<= MAX_ROWS) path used to show
        // no wait estimate at all before Confirm — it previews/confirms as
        // a single unit, bounded by the exact same per-unit budget a
        // chunked file's own first chunk is, so the same estimate applies
        // here, stated before the operator clicks Confirm.
        <p className="mt-2xs text-[13px] text-grey">
          Confirming it is estimated to take up to {describeWaitEstimate(estimateChunkedPhaseWaitSeconds(1))}.
        </p>
      )}

      <dl className="mt-md grid grid-cols-2 gap-sm text-[13px]">
        <SummaryStat label="Total rows" value={summary.totalRows} />
        <SummaryStat label="Passing validation" value={effectivePassingValidationRows} />
        <SummaryStat label="Needs resolution" value={summary.pendingResolutionRows} />
        <SummaryStat label="Errors (excluded)" value={effectiveErrorRows} />
        <SummaryStat label="LWIN matched" value={summary.matchedRows} />
        <SummaryStat label="Missing cost" value={summary.missingCostRows} />
      </dl>
      <p className="mt-2xs text-caption text-grey">
        The server decides the final ready/needs-resolution split at import — missing costs and
        unmatched wines may still need resolution, and duplicate rows may merge.
      </p>
      {fixedCount > 0 && (
        <p className="mt-2xs text-caption text-grey">
          Includes {fixedCount} row{fixedCount === 1 ? "" : "s"} fixed above — re-checked when you confirm.
        </p>
      )}

      {chunkBreakdown && (
        <div className="mt-lg">
          <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">Chunk breakdown</h3>
          <ul className="mt-xs space-y-2xs">
            {chunkBreakdown.map((chunk) => (
              <li key={chunk.index} className="rounded-md bg-wash px-sm py-xs text-[13px] text-ink">
                Chunk {chunk.index} (rows {chunk.startRow}–{chunk.endRow}): {chunk.summary.validRows} valid,{" "}
                {chunk.summary.errorRows} error(s)
              </li>
            ))}
          </ul>
        </div>
      )}

      <PreviewErrorRows
        shownErrorRows={shownErrorRows}
        hiddenCount={hiddenCount}
        rowOverrides={rowOverrides}
        onRowFieldChange={onRowFieldChange}
        isRowLocked={isRowLocked}
        isRowSkipped={isRowSkipped}
        confirming={confirming}
        setShownCount={setShownCount}
      />

      <PreviewMatchedWines
        shownMatchedRows={shownMatchedRows}
        linkingMatchedRows={linkingMatchedRows}
        hiddenMatchedCount={hiddenMatchedCount}
        effectiveRejectedLwinRows={effectiveRejectedLwinRows}
        onToggleLwinReject={onToggleLwinReject}
        isRowLocked={isRowLocked}
        isRowSkipped={isRowSkipped}
        confirming={confirming}
        setShownMatchedCount={setShownMatchedCount}
      />

      <PreviewBelowThreshold
        shownBelowThresholdRows={shownBelowThresholdRows}
        belowThresholdMatchedRows={belowThresholdMatchedRows}
        hiddenBelowThresholdCount={hiddenBelowThresholdCount}
        setShownBelowThresholdCount={setShownBelowThresholdCount}
      />


      {chunkUpload && (
        <ChunkUploadProgress
          chunks={chunkUpload}
          chunkTotal={chunkTotal ?? chunkUpload.length}
          onSkipChunk={onSkipChunk}
          onImportAnyway={onImportAnyway}
          onUndoSkip={onUndoSkip}
          // Round-7 audit finding 4: the same in-flight freeze RowFixItem's
          // own `frozen` prop already applies to row-edit inputs above —
          // Skip/Undo-skip/Import-anyway are chunk actions with the exact
          // same race (a click here would be silently overwritten by the
          // driver's next progress write), so they freeze together.
          frozen={confirming}
        />
      )}

      {/* Round-27 audit (removes the in-preview conflict-recovery panel,
          which failed five straight audits — see docs/runbooks/
          csv-import.md): this is now the ONLY guidance shown for a
          conflict, including multiple_live_batches and duplicate_race_retry
          — the server's own message, verbatim, with no separate standing
          instruction competing with it. Confirm/Retry stays available below
          (blocksConfirmButton no longer treats either code as terminal);
          recovery for multiple_live_batches is under Recent imports. */}
      {error && (
        <p role="alert" className="mt-md flex items-start gap-xs text-[13px] text-risk-ink">
          <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      <div className="mt-lg flex flex-col-reverse gap-sm sm:flex-row">
        <button
          type="button"
          onClick={onBack}
          disabled={confirming}
          className="min-h-11 flex-1 rounded-pill border border-edge bg-surface px-lg text-[14px] font-medium text-ink transition-colors hover:bg-wash focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          Choose a different file
        </button>
        {!blocksConfirmButton && (
          <button
            type="button"
            disabled={!canConfirm || confirming}
            onClick={onConfirm}
            className="flex min-h-11 flex-1 items-center justify-center gap-xs rounded-pill bg-primary px-lg text-[14px] font-medium text-seal-ink transition-colors hover:bg-primary-hover focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            {confirming ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {confirming ? "Creating import…" : hasFailedChunk ? "Retry upload" : "Confirm import"}
          </button>
        )}
      </div>
      {!blocksConfirmButton && !canConfirm && (
        <p className="mt-sm text-caption text-grey">No valid rows to import yet — fix a row below, or choose a different file.</p>
      )}
    </div>
  );
}
