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

/** Round-23 audit (BLOCK 2, round-22 audit): the old note pointed at
 * "Recent imports" and claimed exactly one candidate was missing —
 * wrong on both counts. "Recent imports" shows only the ten newest
 * batches (RecentImports, import-client.tsx), so a conflicting batch old
 * enough to have aged out is not actually reachable there; and the missing
 * count can be more than one, whether from the server's own
 * LIVE_BATCH_LOOKUP_LIMIT cap or from this client dropping more than one
 * malformed entry. This note makes neither claim: it says plainly that
 * some candidates aren't shown, and points at the one recovery that
 * actually works regardless of how many are missing or where they rank by
 * recency — revert what IS shown, then retry, since the server re-checks
 * fresh every time and will report whatever is still live. Shared between
 * import-client.tsx's handleConfirm (plain path) and session-step.tsx's
 * sendChunk (chunked path) so the two surfaces never say different things
 * about the identical situation. */
export const CONFLICT_UNDISPLAYED_NOTE =
  "Not every conflicting batch for this file could be displayed here. Revert what's shown above, then retry — " +
  "the server will report any that remain.";
