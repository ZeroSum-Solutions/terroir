// The chunk plan / chunk upload state vocabulary for the client-side
// auto-chunking flow (a file over MAX_ROWS is split, previewed and
// confirmed one chunk at a time), plus the all-zero PreviewSummary the
// aggregation starts from.
//
// Extracted verbatim from session-step.tsx, which re-exports every name
// here unchanged.

import type { CanonicalHeader } from "./constants";
import type { PreviewSummary } from "./preview-service";
import type { ApprovedLwinRows, ErrorRowEntry, MatchedLwinRowEntry, RowOverrides } from "./review-types";

export type ChunkPlanItem = { index: number; startRow: number; endRow: number; text: string };

export type ChunkedPlanState = {
  headerRecord: string;
  chunkTotal: number;
  chunks: ChunkPlanItem[];
  sourceSha256: string;
};

export type ChunkPreviewEntry = {
  index: number;
  startRow: number;
  endRow: number;
  summary: PreviewSummary;
  /** Round-6 audit finding 3: this chunk's own first data row, exactly as
   * parsed server-side, regardless of that row's validity — sourced so
   * "Import anyway" (see ChunkUploadProgress) can build a deterministic
   * no-op override even for a fully-VALID duplicate chunk with no error
   * rows to ever edit. null only if the chunk somehow reports zero rows
   * (never happens in practice — every chunk has at least one data row by
   * construction). */
  firstRowRawText: Record<CanonicalHeader, string> | null;
};

export type ChunkedPreviewState = {
  summary: PreviewSummary;
  perChunk: ChunkPreviewEntry[];
  errorRows: ErrorRowEntry[];
  /** Item 2 (per-row LWIN match visibility): every matched row across every
   * chunk, mirroring errorRows above exactly (same GLOBAL row-number /
   * chunkIndex / chunkRowNumber convention). */
  matchedRows: MatchedLwinRowEntry[];
};

// Round-5 audit finding 4: "skipped" is a purely CLIENT-SIDE terminal state
// — never sent to, or acknowledged by, the server (migrations are locked,
// there is no DB column for it). It means "the operator chose not to
// re-attempt this chunk," used to escape the permanent dead end a fully-
// valid duplicate_chunk_content chunk (no error rows, so no override to
// edit) would otherwise be — see ChunkUploadState.skippedDuplicateOfChunkIndex.
export type ChunkUploadStatus = "pending" | "waiting" | "uploading" | "confirmed" | "failed" | "skipped";
export type ChunkUploadState = {
  index: number;
  status: ChunkUploadStatus;
  batchId: string | null;
  error: string | null;
  /** Sol round-2 audit (2026-08-27) finding 3: the server's error CODE for a
   * "failed" chunk, when there is one — e.g. "chunk_content_mismatch",
   * which is TERMINAL (retrying re-sends the exact same content and will
   * fail again the same way). null for a failure with no typed code
   * (network error, generic upload failure), and for every state that
   * never carried one in the first place ("pending", "waiting",
   * "uploading", "confirmed").
   *
   * Round-6 audit finding 5, corrected by round-7 audit finding 6: this
   * comment used to also claim "null for every non-error state" — false
   * once a chunk reaches "skipped": handleSkipChunk (import-client.tsx)
   * deliberately PRESERVES code (and error) from the prior "failed" state
   * rather than clearing them, specifically so handleUndoSkip can restore
   * the exact failed state without reconstructing anything. "skipped" is
   * not an error state, but it CAN carry a non-null code — the only
   * accurate claim is "null for a codeless failure or a state that never
   * had one." */
  code: string | null;
  /** Round-5 audit finding 3: the operator's override slice for THIS
   * chunk's rows (GLOBAL row numbers, same keying as RowOverrides).
   * exactly as it was included in the confirm attempt that failed with
   * duplicate_chunk_content — captured so the client can tell "an override
   * exists" (true forever after a single edit) apart from "the override
   * CHANGED since the collision" (the only thing that actually produces a
   * different content_sha256 and can plausibly resolve it on retry).
   * undefined until a duplicate_chunk_content failure actually occurs. */
  sentOverridesSnapshot?: RowOverrides;
  /** Sol audit round 3, WARN 5: the rejectedLwinRows counterpart to
   * sentOverridesSnapshot above — this chunk's own slice of GLOBAL row
   * numbers the operator had rejected, exactly as sent with the failed
   * duplicate_chunk_content attempt. A rejection changes the v2/v3
   * content_sha256 namespace exactly like an override does (see
   * confirmImportBatch's own digest-construction comment), so the
   * retry gate must compare THIS too, not just sentOverridesSnapshot —
   * otherwise rejecting (or un-rejecting) a match after a collision left
   * Confirm/Retry permanently hidden even though the next attempt would
   * genuinely hash differently. undefined until a duplicate_chunk_content
   * failure actually occurs. */
  sentRejectedLwinRowsSnapshot?: number[];
  /** Sol audit round 3, WARN 5 / BLOCK 2: the approvedLwinRows counterpart
   * to sentOverridesSnapshot above — this chunk's own slice of GLOBAL row
   * number -> approved lwin_id, exactly as sent with the failed
   * duplicate_chunk_content attempt. Same reasoning as
   * sentRejectedLwinRowsSnapshot: BLOCK 2's approved-match set also
   * namespaces content_sha256 (v3), so a change here must reopen retry
   * too. undefined until a duplicate_chunk_content failure actually
   * occurs. */
  sentApprovedLwinRowsSnapshot?: ApprovedLwinRows;
  /** Round-5 audit finding 3/4: the sibling chunk index (body.chunkIndex
   * from the server's alreadyExists response) THIS chunk's content
   * collided with, when status is "failed" with code "duplicate_chunk_content"
   * — or, once the operator skips it, the same value carried onto
   * "skipped" so the session summary can name it. undefined otherwise. */
  duplicateOfChunkIndex?: number;
};

export const ZERO_SUMMARY: PreviewSummary = {
  totalRows: 0,
  validRows: 0,
  errorRows: 0,
  matchedRows: 0,
  unmatchedRows: 0,
  missingCostRows: 0,
  readyToApplyRows: 0,
  pendingResolutionRows: 0,
  missingProducerRows: 0,
};
