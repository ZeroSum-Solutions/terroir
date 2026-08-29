// Applying confirm-time LWIN rejections and approvals to preview rows.
//
// Second seam split out of batch-service.ts (see confirm-digest.ts for the
// first). Like that one, every function here is PURE: it maps preview rows to
// new preview rows, touches no Supabase client and holds no state, so it is
// readable and testable without the confirm/apply/revert machinery around it.
//
// Nothing here changed — the definitions are byte-identical to their previous
// ones, only relocated. batch-service.ts re-exports applyLwinRejections and
// applyLwinApprovalVeto, so its public surface is exactly what it was.

import type { PreviewRow } from "./preview-service";
import { LWIN_APPLY_MIN_SCORE } from "./constants";

/** Item 2 (per-row LWIN match visibility/rejection) — a rejected match
 * behaves EXACTLY like a row that never matched at all: lwinStatus/lwinId/
 * lwinScore/lwinDisplayName null out, and resolution recomputes through
 * the SAME rule buildImportPreview itself uses (an unmatched row always
 * needs resolution) so the row goes through the ordinary "Include anyway"/
 * "Exclude" gate every unmatched row already goes through — never a
 * separate auto-apply path. No SQL change is needed for this: apply_
 * import_batch_chunk (0108) independently re-gates on `lwin_score is not
 * null and lwin_score >= 0.6`, so a nulled lwin_score alone already makes
 * this row un-appliable via the LWIN path.
 *
 * A row not currently 'matched' (never matched, or already excluded as an
 * error row) is a no-op — rejecting a match that isn't there has nothing
 * to undo. This also makes a REJECTION of a row an operator's override
 * happened to change into something else at confirm time (a different
 * effective producer/name re-matching, or matching nothing) harmless
 * rather than an error: rejection is about the row's CURRENT match, not a
 * promise the same match still exists.
 *
 * Pure — returns a NEW array, never mutates its input (this codebase's
 * immutability convention), and returns the SAME array reference when
 * there is nothing to reject so an empty rejection set costs nothing.
 * Exported so batch-service.test.ts can pin this transformation directly. */
export function applyLwinRejections(rows: PreviewRow[], rejectedRowNumbers: Set<number>): PreviewRow[] {
  if (rejectedRowNumbers.size === 0) return rows;
  return rows.map((row) => {
    if (row.lwinStatus !== "matched" || !rejectedRowNumbers.has(row.rowNumber)) return row;
    return {
      ...row,
      lwinStatus: "unmatched",
      lwinId: null,
      lwinScore: null,
      lwinDisplayName: null,
      resolution: "pending",
    };
  });
}
/** Sol audit round 3, finding 2 (BLOCK 2) — match_lwin's catalogue
 * tie-break (0078_match_lwin_trgm_fastpath.sql) orders candidates by
 * `score desc limit 1` with no deterministic secondary key, so two
 * equally-scoring catalogue rows can legitimately resolve to a DIFFERENT
 * lwin_id between the preview the operator looked at and confirm's own
 * from-scratch re-match (buildImportPreview is called again, above, from
 * the raw file — it never trusts a client-supplied preview).
 *
 * That catalogue tie is now fixed at the source: migration 0127 adds
 * `order by score desc, lc.lwin_id asc`, and match_lwin_bulk inherits it by
 * delegation. This veto is NOT thereby redundant, and must not be deleted on
 * the strength of that migration — it defends against a strictly larger set
 * of causes than tie ordering. The catalogue itself can change between
 * preview and confirm (a row added, edited, removed, or newly crossing the
 * threshold), and the operator's approval is a statement about the specific
 * wine they were shown, not about whichever wine the RPC ranks first at
 * confirm time.
 *
 * BLOCK 1 (round 5 fix) — this used to be a PARTIAL fail-safe: a row with
 * NO entry in approvedByRowNumber was left completely untouched, on the
 * theory that "no entry" only ever meant "an older client, or a row the
 * operator's client never showed as matched." That reasoning was wrong for
 * the real client: buildApprovedLwinRows (import-client.tsx) only ever
 * includes a row that was shown as LINKING (score >= LWIN_APPLY_MIN_SCORE)
 * at preview — a row that was unmatched or below-threshold at preview has
 * NO entry either, for exactly the same "no entry" shape, even though the
 * operator explicitly did NOT see it as linking. If that row re-scores >=
 * LWIN_APPLY_MIN_SCORE at confirm (a catalogue update between preview and
 * confirm, or match_lwin's own non-deterministic tie-break landing on a
 * candidate this time), the old code stamped it — a catalogue link the
 * operator never saw, contradicting the UI's own promise that a
 * below-threshold/unmatched row imports with no link "no matter what you
 * do here" (import-client.tsx).
 *
 * Fixed by making "no entry" fail CLOSED instead of open, but only when the
 * client has actually communicated the full picture — `hasFullPicture`
 * (confirmImportBatch's own `options.approvedLwinRows !== undefined`,
 * threaded straight through, never re-derived from approvedByRowNumber's
 * size) is true whenever approvedLwinRows was sent AT ALL, even as `{}` for
 * a file with zero linking matches — see buildApprovedLwinRows'/
 * handleConfirm's own comment in import-client.tsx for why the client now
 * always sends it. When `hasFullPicture` is false (the field was never sent
 * — a genuinely older client, a bare API caller with no preview UI to show
 * anything through), the veto is a complete no-op, unchanged from before:
 * there is no signal to fail closed WITH, and "no data" must never be
 * treated as "operator saw this and rejected it."
 *
 * When `hasFullPicture` is true, EVERY row that would actually be stamped
 * (lwinStatus 'matched' AND score >= LWIN_APPLY_MIN_SCORE — a below-
 * threshold match is excluded from this gate entirely, since 0108's own SQL
 * already refuses to write one regardless, and vetoing it here would wrongly
 * flip its resolution from 'auto' to 'pending', a BLOCK-3 contract this fix
 * has no business touching) must have a MATCHING entry in
 * approvedByRowNumber to survive: no entry, or a disagreeing one, both
 * veto identically (stamped exactly like a rejected row — see
 * applyLwinRejections above). Only a row the operator saw as linking, whose
 * re-derived id still agrees, keeps its link.
 *
 * The client's data is still only ever a comparison target, never a
 * written value — confirm re-derives every match itself, exactly as
 * before — and this mechanism still can only ever cause LESS to be written
 * than the server's own re-match alone would, never more or different:
 * `hasFullPicture=false` reproduces the exact prior behavior, and
 * `hasFullPicture=true` can only turn an already-computed match INTO
 * "unmatched," never the reverse.
 *
 * Applied AFTER applyLwinRejections (confirmImportBatch's own call order)
 * — a row already nulled out by an explicit rejection has lwinStatus
 * 'unmatched' by the time this runs, so any approvedLwinRows entry for it
 * is naturally a no-op here, never double-processed.
 *
 * Pure — same immutability contract as applyLwinRejections: returns a NEW
 * array, and returns the SAME array reference when `hasFullPicture` is
 * false (the one case cheap enough, and common enough for a bare API
 * caller, to special-case). Exported so batch-service.test.ts can pin this
 * transformation directly. */
export function applyLwinApprovalVeto(
  rows: PreviewRow[],
  approvedByRowNumber: Map<number, string>,
  hasFullPicture: boolean,
): PreviewRow[] {
  if (!hasFullPicture) return rows;
  return rows.map((row) => {
    if (row.lwinStatus !== "matched") return row;
    if (row.lwinScore === null || row.lwinScore < LWIN_APPLY_MIN_SCORE) return row;
    const approvedLwinId = approvedByRowNumber.get(row.rowNumber);
    if (approvedLwinId === row.lwinId) return row;
    return {
      ...row,
      lwinStatus: "unmatched",
      lwinId: null,
      lwinScore: null,
      lwinDisplayName: null,
      resolution: "pending",
    };
  });
}
/** Item 2's dynamic bounds check — the rejectedLwinRows counterpart to
 * buildImportPreview's own rowOverrides bounds check (preview-service.ts).
 * Deliberately checked against the rowNumbers actually PRESENT in `rows`
 * (post intra-batch-duplicate-merge — see mergeIntraBatchDuplicates,
 * dedup-key.ts) rather than a static row-count ceiling: a merge-absorbed
 * row's number never appears standalone in the preview the operator saw
 * (it only ever shows survivor rows), so any well-formed operator
 * submission can only ever name a survivor's own rowNumber — an index
 * that no longer exists post-merge is either a stale/mismatched client
 * reference or a hand-crafted request, and either way is never silently
 * ignored (matching buildImportPreview's own rowOverrides discipline). */
export function checkRejectedLwinRows(rejectedLwinRows: string[] | undefined, rows: PreviewRow[]): RejectedLwinRowsCheck {
  if (!rejectedLwinRows || rejectedLwinRows.length === 0) return { ok: true, rowNumbers: new Set() };
  const validRowNumbers = new Set(rows.map((r) => r.rowNumber));
  const rowNumbers = new Set<number>();
  for (const key of rejectedLwinRows) {
    const rowNumber = Number(key);
    if (!Number.isInteger(rowNumber) || !validRowNumbers.has(rowNumber)) {
      return {
        ok: false,
        error: {
          code: "invalid_rejected_lwin_row",
          message: `Row ${key} does not exist in this file's preview (it has ${rows.length} row(s) after merging duplicates).`,
        },
      };
    }
    rowNumbers.add(rowNumber);
  }
  return { ok: true, rowNumbers };
}
/** Sol audit round 3, finding 2 (BLOCK 2) — the approvedLwinRows
 * counterpart to checkRejectedLwinRows above: same "validated against the
 * rowNumbers actually PRESENT in `rows`, post intra-batch-duplicate-merge"
 * discipline (see checkRejectedLwinRows' own comment for why), and the
 * same "never silently ignored" failure mode for an out-of-range row
 * reference. The lwin_id VALUE is only shape-checked (a non-empty string)
 * — applyLwinApprovalVeto never trusts it as anything but a comparison
 * target, so there is nothing more to validate about it here. */
export function checkApprovedLwinRows(
  approvedLwinRows: Record<string, string> | undefined,
  rows: PreviewRow[],
): ApprovedLwinRowsCheck {
  if (!approvedLwinRows) return { ok: true, approvedByRowNumber: new Map() };
  const validRowNumbers = new Set(rows.map((r) => r.rowNumber));
  const approvedByRowNumber = new Map<number, string>();
  for (const [key, lwinId] of Object.entries(approvedLwinRows)) {
    const rowNumber = Number(key);
    if (!Number.isInteger(rowNumber) || !validRowNumbers.has(rowNumber)) {
      return {
        ok: false,
        error: {
          code: "invalid_approved_lwin_row",
          message: `Row ${key} does not exist in this file's preview (it has ${rows.length} row(s) after merging duplicates).`,
        },
      };
    }
    if (typeof lwinId !== "string" || lwinId.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid_approved_lwin_row",
          message: `Row ${key}'s approved LWIN id must be a non-empty string.`,
        },
      };
    }
    approvedByRowNumber.set(rowNumber, lwinId);
  }
  return { ok: true, approvedByRowNumber };
}
export type RejectedLwinRowsCheck =
  | { ok: true; rowNumbers: Set<number> }
  | { ok: false; error: { code: string; message: string } };
export type ApprovedLwinRowsCheck =
  | { ok: true; approvedByRowNumber: Map<number, string> }
  | { ok: false; error: { code: string; message: string } };
