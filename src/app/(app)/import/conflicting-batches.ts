// FINDING 7 (round-15 audit): ConflictingBatchInfo and parseConflictingBatches
// used to live in import-client.tsx, with session-step.tsx importing
// parseConflictingBatches (a runtime VALUE, not a type) back from it — a real
// import cycle, even though it only avoided a TDZ failure because the
// binding is read at call time rather than at module-eval time. Both files
// need this same guard, so it lives here instead — a neutral module neither
// of them owns — closing the cycle rather than merely surviving it.

/** FINDING 2 (round-11 audit): mirrors batch-service.ts's own
 * ConflictingBatchInfo — carried on a multiple_live_batches error's
 * `details.conflictingBatches` so the conflict UI can render a revert
 * affordance per candidate directly, rather than relying on the batch
 * still being in the ten-newest Recent imports list. */
export type ConflictingBatchInfo = { id: string; filename: string; status: string; created_at: string };

/** NIT 7 (round-13 audit): conflictingBatches arrives over the wire inside
 * a 422 error body's `details` and used to be trusted through a bare `as`/
 * type-annotation assertion — a malformed entry (any external response
 * shape drift, a proxy/CDN rewriting the body, etc.) could crash the
 * merge/dedup logic in ImportClient (the `.filter`/`.findIndex` calls
 * building `conflictingBatches`) or the revert list's `key` prop. Validated
 * at the boundary the same way this codebase validates other external
 * input — a small hand-written type guard, matching batch-service.ts's own
 * style (e.g. isWellFormedDigestForFile) rather than pulling a schema
 * library into this client bundle for one shape. Malformed entries are
 * dropped, never allowed to crash the UI. */
function isConflictingBatchInfo(value: unknown): value is ConflictingBatchInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.filename === "string" &&
    typeof v.status === "string" &&
    typeof v.created_at === "string"
  );
}

/** Returns `undefined` when `value` isn't an array at all (the field was
 * simply absent — every non-multiple_live_batches error), matching the
 * shape callers already expect for "no conflicting batches were reported."
 * When it IS an array, malformed entries are filtered out rather than
 * propagated. */
export function parseConflictingBatches(value: unknown): ConflictingBatchInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isConflictingBatchInfo);
}

/** Round-23 audit (SIMPLIFY): this module used to also export
 * isConflictSourceResolved — a client-side "is this multiple_live_batches
 * conflict resolved" threshold, mirroring reconcileLiveBatchesForFile's own
 * `candidates.length <= 1`. Three straight audits (rounds 18, 20, 22) found
 * a different way that local inference got the answer wrong: stale copy
 * left after clearing the code, a parse failure mistaken for a reverted
 * batch, and a capped lower-bound count decremented as if it were exact.
 * The client no longer tries to know whether the conflict is resolved at
 * all — reconcileLiveBatchesForFile (batch-service.ts) already re-checks
 * the live count on every confirm attempt, so that's the only thing this
 * codebase trusts to answer the question now. import-client.tsx's
 * handleRevertConflict drops a successfully-reverted candidate from the
 * panel and exposes a retry affordance instead of guessing "resolved." */

/** Round-25 audit (SHARED ROOT CAUSE): the STANDING on-screen instruction
 * for a live multiple_live_batches conflict — recomputed from CURRENT
 * client state on every render (displayed-candidate count, truncation
 * flag), never baked once from the server's one-shot response and left to
 * go stale as reverts land underneath it. The server's own message
 * (rendered separately, verbatim, as the one-time reason THIS confirm
 * attempt failed) is not touched by this function at all.
 *
 * Never names a specific count: BLOCK 1 (round-25 audit) was exactly a
 * count/instruction that stayed on screen unchanged while the operator
 * reverted candidates out from under it — a count is precisely the kind of
 * detail that goes stale.
 *
 * `hasDisplayedCandidates` false is BLOCK 2 (round-25 audit): every
 * candidate failed to parse (or the server reported none), so "revert
 * what's shown above" is nonsensical — there is nothing shown. That case
 * must say what the operator can actually do: retry (always available now
 * — see PreviewStep's own hasTerminalReconciliationConflict comment) and
 * where else to look, never repeat the old dead-end wording.
 *
 * `mayHaveMore` softens the guidance to a possibility, never a certainty —
 * WARN (round-25 audit): batch-service.ts's own rawReadHitCap/
 * conflictingBatchesTruncated means additional candidates MAY exist; an
 * exact-at-the-cap read that happens to have nothing beyond it also sets
 * the flag, so claiming categorically that some are missing would
 * sometimes be false. "There may be more" is honest either way.
 *
 * Shared between import-client.tsx's PreviewStep (plain and chunked paths
 * both render through it) so the two surfaces never say different things
 * about the identical situation. */
export function conflictStandingInstruction(hasDisplayedCandidates: boolean, mayHaveMore: boolean): string {
  if (!hasDisplayedCandidates) {
    return (
      "This file has another import in progress that couldn't be listed here. Retry — it re-checks with the " +
      "server and will report what's still live — or look for the conflicting batch under Recent imports."
    );
  }
  return mayHaveMore
    ? "This file has other imports in progress, and there may be more than are listed below. Revert the ones " +
      "shown, then retry — the retry re-checks with the server."
    : "This file has other imports in progress. Revert the ones listed below, then retry — the retry re-checks " +
      "with the server.";
}
