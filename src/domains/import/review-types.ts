// The operator's preview-review vocabulary: the row shapes the import
// preview UI renders, and the three decision payloads it sends back with a
// confirm (inline row fixes, rejected LWIN matches, approved LWIN matches).
//
// Extracted verbatim from import-client.tsx, which re-exports every name
// here unchanged — server-side validation (request-schemas.ts,
// batch-service.ts) remains the sole authority on all three payloads.

import type { CanonicalHeader } from "./constants";

/** One error row's worth of prefill text for the inline row-fix form —
 * the exact text the row was validated against, for every canonical
 * field (see row-validator.ts's ValidatedRow.rawText). rowNumber is the
 * override-targeting key (see RowOverrides below) — for the chunked path
 * it's a startRow-adjusted pseudo-global number that must NEVER be
 * changed (session-step.tsx's localizeRowOverrides depends on its exact
 * arithmetic). chunkIndex/chunkRowNumber are set ONLY for the chunked
 * path and carry the HONEST display label instead (Sol round-2 audit
 * (2026-08-27) finding 5) — RowFixItem renders "Chunk N, data row M"
 * from these two when present, never a claim that rowNumber is this
 * row's true physical position in the original file. */
export type ErrorRowEntry = {
  rowNumber: number;
  chunkIndex?: number;
  chunkRowNumber?: number;
  errors: { field: string; message: string }[];
  rawText: Record<CanonicalHeader, string>;
};

/** Item 2 (per-row LWIN match visibility): one matched row's worth of
 * display info for the "Matched wines" section — same rowNumber/chunkIndex/
 * chunkRowNumber convention as ErrorRowEntry above (GLOBAL row number for
 * both paths; chunkIndex/chunkRowNumber set ONLY for the chunked path, for
 * the same honest "Chunk N, data row M" label). lwinId is carried so a
 * reject toggle always knows exactly which match it's rejecting, even
 * though it isn't rendered directly. */
export type MatchedLwinRowEntry = {
  rowNumber: number;
  chunkIndex?: number;
  chunkRowNumber?: number;
  lwinId: string;
  lwinDisplayName: string | null;
  lwinScore: number;
};

/** rowNumber -> true for a matched row whose LWIN link the operator
 * rejected. GLOBAL row numbers, same keying as RowOverrides/ErrorRowEntry.
 * Sent to confirm as an explicit rejectedLwinRows payload — server-side
 * re-validation stays the sole authority (a rejected row that no longer
 * matches at confirm time, e.g. because an override also changed its text,
 * is simply a harmless no-op there — see applyLwinRejections'
 * (batch-service.ts) own comment). */
export type RejectedLwinRows = Set<number>;

/** BLOCK 2 (Sol audit round 3, finding 2) — GLOBAL row number -> the
 * lwin_id the operator saw and accepted for that row in preview. Built
 * fresh at confirm time from the CURRENT matched-rows list (never a
 * separate piece of user-editable state — there is nothing for the
 * operator to "set" here beyond what preview already showed), and sent as
 * an explicit approvedLwinRows payload so confirm's own from-scratch
 * re-match can VETO a disagreeing result instead of silently persisting
 * it — see applyLwinApprovalVeto's (batch-service.ts) own comment for the
 * full mechanics and why this can never let confirm write MORE or
 * DIFFERENT than its own re-match already decided. */
export type ApprovedLwinRows = Record<number, string>;

/** rowNumber -> canonical field -> the operator's edited replacement
 * text. Sent to confirm as an explicit overrides payload — server-side
 * validation stays the sole authority (see request-schemas.ts's
 * RowOverridesSchema and batch-service.ts's confirmImportBatch). */
export type RowOverrides = Record<number, Partial<Record<CanonicalHeader, string>>>;
