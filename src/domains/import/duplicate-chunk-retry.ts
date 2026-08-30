// The "did this genuinely change" retry gate for a chunk stuck on
// duplicate_chunk_content. A chunk's server-side content_sha256 folds in
// all THREE operator decision payloads (overrides, rejected matches,
// approved matches), so Retry stays hidden only while EVERY one of them
// still exactly matches what the failed attempt sent — an unchanged slice
// reproduces the identical digest, hence the identical collision, forever.
//
// Extracted verbatim from import-client.tsx: the three slice comparisons
// were module-private helpers there, and computeUnresolvedDuplicateChunkContentIndexes
// is the same computation PreviewStep ran inline in its render body,
// unchanged, now callable (and testable) without rendering the component.

import { LWIN_APPLY_MIN_SCORE, type CanonicalHeader } from "./constants";
import type { ChunkUploadState } from "./chunked-upload-types";
import type { ApprovedLwinRows, MatchedLwinRowEntry, RejectedLwinRows, RowOverrides } from "./review-types";

/** Round-5 audit finding 3: whether two override slices for the same chunk
 * are the SAME edit — an order-independent, deep value comparison used
 * only to gate the "Retry upload" button on a chunk stuck at
 * duplicate_chunk_content (an unchanged override reproduces the identical
 * canonical overrides JSON server-side, hence the identical namespaced
 * digest, hence the identical collision, forever). It does NOT need to
 * exactly mirror batch-service.ts's own canonicalizeRowOverrides — that
 * function is server-only (pulls in node:crypto, never importable from a
 * client component) — it only needs to reliably distinguish "identical"
 * from "different"; the server's own digest remains the actual authority
 * on whether a retry produces a new content_sha256. */
export function overridesSliceEqual(
  a: Record<number, Partial<Record<CanonicalHeader, string>>>,
  b: Record<number, Partial<Record<CanonicalHeader, string>>>,
): boolean {
  const normalize = (slice: Record<number, Partial<Record<CanonicalHeader, string>>>) =>
    Object.entries(slice)
      .map(([rowNumber, fields]) => [
        Number(rowNumber),
        Object.entries(fields ?? {})
          .filter(([, value]) => value !== undefined)
          .sort(([fieldA], [fieldB]) => fieldA.localeCompare(fieldB)),
      ] as const)
      .filter(([, fields]) => fields.length > 0)
      .sort(([rowA], [rowB]) => rowA - rowB);
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** WARN 5 (Sol audit round 3) — the rejectedLwinRows counterpart to
 * overridesSliceEqual above: an order-independent, dedup-aware comparison
 * of two row-number slices, for the identical "did this genuinely change"
 * retry gate. */
export function numberSliceEqual(a: number[], b: number[]): boolean {
  const normalize = (rows: number[]) => Array.from(new Set(rows)).sort((x, y) => x - y);
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** WARN 5 / BLOCK 2 (Sol audit round 3) — the approvedLwinRows counterpart
 * to overridesSliceEqual above: an order-independent comparison of two
 * (row number -> lwin_id) slices. */
export function approvedSliceEqual(a: ApprovedLwinRows, b: ApprovedLwinRows): boolean {
  const normalize = (rec: ApprovedLwinRows) =>
    Object.entries(rec)
      .map(([rowNumber, lwinId]) => [Number(rowNumber), lwinId] as const)
      .sort(([rowA], [rowB]) => rowA - rowB);
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** The chunk indexes currently stuck on duplicate_chunk_content with no
 * genuinely changed payload behind them — PreviewStep hides Confirm/Retry
 * while this is non-empty. `chunkBreakdown` supplies each chunk's own
 * [startRow, endRow] bounds (rather than filtering errorRows down to the
 * chunk's own) so an override on a NON-error row counts too — exactly what
 * "Import anyway" produces for a fully-valid duplicate chunk. */
export function computeUnresolvedDuplicateChunkContentIndexes({
  chunkUpload,
  chunkBreakdown,
  rowOverrides,
  rejectedLwinRows,
  matchedRows,
}: {
  chunkUpload: ChunkUploadState[] | null;
  chunkBreakdown: { index: number; startRow: number; endRow: number }[] | undefined;
  rowOverrides: RowOverrides;
  rejectedLwinRows: RejectedLwinRows;
  matchedRows: MatchedLwinRowEntry[];
}): Set<number> {
  return new Set(
    (chunkUpload ?? [])
      .filter((c) => c.status === "failed" && c.code === "duplicate_chunk_content")
      .filter((c) => {
        const bounds = chunkBreakdown?.find((cb) => cb.index === c.index);
        const currentOverridesSlice: RowOverrides = {};
        const currentRejectedSlice: number[] = [];
        const currentApprovedSlice: ApprovedLwinRows = {};
        if (bounds) {
          for (const [key, fields] of Object.entries(rowOverrides)) {
            const rowNumber = Number(key);
            if (rowNumber < bounds.startRow || rowNumber > bounds.endRow) continue;
            if (fields && Object.keys(fields).length > 0) currentOverridesSlice[rowNumber] = fields;
          }
          for (const rowNumber of rejectedLwinRows) {
            if (rowNumber >= bounds.startRow && rowNumber <= bounds.endRow) currentRejectedSlice.push(rowNumber);
          }
          for (const row of matchedRows) {
            if (row.rowNumber < bounds.startRow || row.rowNumber > bounds.endRow) continue;
            // BLOCK 2 (round-13 fix): same fail-closed condition as
            // buildApprovedLwinRows — this slice must match what was
            // actually SENT with the failed attempt (sentApprovedLwinRowsSnapshot),
            // and buildApprovedLwinRows never sends an entry for a row with
            // no display identity.
            if (row.lwinScore >= LWIN_APPLY_MIN_SCORE && row.lwinDisplayName !== null) {
              currentApprovedSlice[row.rowNumber] = row.lwinId;
            }
          }
        }
        return (
          overridesSliceEqual(currentOverridesSlice, c.sentOverridesSnapshot ?? {}) &&
          numberSliceEqual(currentRejectedSlice, c.sentRejectedLwinRowsSnapshot ?? []) &&
          approvedSliceEqual(currentApprovedSlice, c.sentApprovedLwinRowsSnapshot ?? {})
        );
      })
      .map((c) => c.index),
  );
}
