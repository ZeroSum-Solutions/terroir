// The approvedLwinRows payload one confirm attempt echoes back, and the
// matched-row list the plain (non-chunked) path derives it from. Extracted
// verbatim from import-client.tsx, which re-exports buildApprovedLwinRows
// unchanged; matchedRowsFromPreviewRows was module-private there and is
// exported here so preview-step.tsx and import-client.tsx share one
// definition of "matched" for the single-file path, exactly as before.

import { LWIN_APPLY_MIN_SCORE } from "./constants";
import type { PreviewRow } from "./preview-service";
import type { ApprovedLwinRows, MatchedLwinRowEntry } from "./review-types";

/** BLOCK 2 — builds the approvedLwinRows payload for one confirm attempt
 * from the matched rows currently shown to the operator: every row at or
 * above the apply threshold (LWIN_APPLY_MIN_SCORE) gets its currently
 * shown lwin_id echoed back. Below-threshold matches are excluded — apply
 * never stamps those regardless of agreement (BLOCK 3), so there is
 * nothing for the veto to ever protect there. Included even for a row the
 * operator has separately rejected (rejectedLwinRows) — applyLwinApprovalVeto
 * runs AFTER rejections are applied server-side, so an approved entry for
 * an already-rejected row is a harmless no-op, never double-processed.
 *
 * BLOCK 2 (round-13 fix) — an apply-eligible row is ALSO excluded when it
 * has no display identity (lwinDisplayName === null): the operator was
 * never actually shown what this match claims to be (see
 * MatchedLwinRowItem/its `linkingMatchedRows` filter below, which apply
 * the identical condition so a no-identity row is never rendered as
 * "linking" in the first place), so there is nothing here for them to have
 * approved. Excluding it here is what makes that failure mode fail
 * CLOSED: applyLwinApprovalVeto (batch-service.ts) treats any apply-
 * eligible row absent from this payload exactly like an explicit
 * rejection, so a match match_lwin_bulk itself returned with no name can
 * never be auto-stamped — this residual should be all but impossible now
 * that display_name comes straight off the same RPC row as lwinId/score
 * (lwin-matching.ts), but the gate stays defensive rather than assuming
 * that invariant forever. */
export function buildApprovedLwinRows(matchedRows: MatchedLwinRowEntry[]): ApprovedLwinRows {
  const approved: ApprovedLwinRows = {};
  for (const row of matchedRows) {
    if (row.lwinScore >= LWIN_APPLY_MIN_SCORE && row.lwinDisplayName !== null) approved[row.rowNumber] = row.lwinId;
  }
  return approved;
}

/** Builds the MatchedLwinRowEntry[] shape PreviewStep (and, via
 * buildApprovedLwinRows, handleConfirm) both need, from the plain
 * (non-chunked) preview's own rows — extracted so the two call sites can
 * never drift on what counts as "matched" for the single-file path. The
 * chunked path already gets this shape directly from planChunkedPreview
 * (session-step.tsx's ChunkedPreviewState.matchedRows). */
export function matchedRowsFromPreviewRows(rows: PreviewRow[]): MatchedLwinRowEntry[] {
  return rows
    .filter((r): r is PreviewRow & { lwinId: string; lwinScore: number } => r.lwinStatus === "matched" && r.lwinId !== null)
    .map((r) => ({
      rowNumber: r.rowNumber,
      lwinId: r.lwinId,
      lwinDisplayName: r.lwinDisplayName,
      lwinScore: r.lwinScore,
    }));
}
