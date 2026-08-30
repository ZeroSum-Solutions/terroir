// Pure transitions and predicates over the client-side chunk upload state:
// whether a given GLOBAL row number belongs to a confirmed or a skipped
// chunk (both make an inline edit impossible to ever resend), and the
// skip/undo-skip transitions themselves.
//
// Extracted verbatim from import-client.tsx, which re-exports all four
// unchanged.

import type { ChunkUploadState, ChunkedPlanState } from "./chunked-upload-types";

/** Sol round-2 audit (2026-08-27) finding 1: which GLOBAL row numbers
 * currently belong to an already-CONFIRMED chunk. confirmChunkedSession's
 * retry loop skips a chunk once it's "confirmed" (session-step.tsx) —
 * further edits to that chunk's rows can never actually be resent, so
 * leaving their inputs enabled would silently discard the operator's
 * fix with no signal at all. Exported as a pure function so its boundary
 * behavior can be pinned directly, without rendering the full component
 * tree. Always false for the plain (non-chunked) path. */
export function isRowInConfirmedChunk(
  rowNumber: number,
  chunkedPlan: ChunkedPlanState | null,
  chunkUpload: ChunkUploadState[] | null,
): boolean {
  if (!chunkedPlan || !chunkUpload) return false;
  return chunkedPlan.chunks.some((chunk) => {
    if (rowNumber < chunk.startRow || rowNumber > chunk.endRow) return false;
    return chunkUpload.find((u) => u.index === chunk.index)?.status === "confirmed";
  });
}

/** Round-6 audit finding 5: the skipped-chunk counterpart of
 * isRowInConfirmedChunk — a skipped chunk's rows were never sent to the
 * server at all, so an edit here is just as impossible to ever resend as
 * one on a confirmed chunk's rows. Kept as a SEPARATE predicate (rather
 * than folding into isRowInConfirmedChunk) because RowFixItem needs to
 * render a distinct, honest message for each case. */
export function isRowInSkippedChunk(
  rowNumber: number,
  chunkedPlan: ChunkedPlanState | null,
  chunkUpload: ChunkUploadState[] | null,
): boolean {
  if (!chunkedPlan || !chunkUpload) return false;
  return chunkedPlan.chunks.some((chunk) => {
    if (rowNumber < chunk.startRow || rowNumber > chunk.endRow) return false;
    return chunkUpload.find((u) => u.index === chunk.index)?.status === "skipped";
  });
}

/** Round-5 audit finding 4: marks a chunk stuck on duplicate_chunk_content
 * "skipped" — client-side only (see ChunkUploadState's own comment).
 * confirmChunkedSession never re-attempts a "skipped" chunk, and it no
 * longer counts toward PreviewStep's blocksConfirmButton, so the operator
 * can proceed with every OTHER chunk instead of being stuck forever on one
 * they've decided not to import.
 *
 * Round-6 audit finding 5: error/code are no longer nulled out on skip —
 * both are only ever read while a chunk's status is "failed" (the
 * unresolvedDuplicateChunkContentIndexes gate, and ChunkUploadProgress's
 * own error-line rendering), so keeping them costs nothing and is what
 * lets undoSkipChunk below restore the exact failed state, without
 * reconstructing anything. Exported as a pure function (round-7 audit
 * finding 6) so the real skip transition can be pinned directly, through
 * actual rendered state, rather than a hand-authored fixture. */
export function skipChunk(upload: ChunkUploadState[], index: number): ChunkUploadState[] {
  return upload.map((c) => (c.index === index ? { ...c, status: "skipped" } : c));
}

/** Round-6 audit finding 5: the inverse of skipChunk — restores a skipped
 * chunk to its prior failed/duplicate_chunk_content state, with both
 * "Import anyway" and "Skip this chunk" available again. Skip is purely
 * client-side state (see ChunkUploadState's own comment), so undoing it is
 * too: nothing server-side was ever touched. Exported as a pure function
 * for the same reason as skipChunk above. */
export function undoSkipChunk(upload: ChunkUploadState[], index: number): ChunkUploadState[] {
  return upload.map((c) => (c.index === index && c.status === "skipped" ? { ...c, status: "failed" } : c));
}
