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

/** FINDING 1 (round-15 audit), moved here round-17, CORRECTED round-21: the
 * server's own resolved threshold — reconcileLiveBatchesForFile
 * (batch-service.ts) treats `candidates.length <= 1` as nothing left to
 * reconcile, not `=== 0`. With two real candidates, reverting ONE already
 * resolves the conflict server-side.
 *
 * Round-17/19 audit (WRONG PREMISE, corrected round-21): this used to take
 * ONLY the parsed `conflictingBatches` array and apply the <=1 threshold to
 * its `.length` directly — reasoning that a list which somehow arrived
 * already at length <= 1 must mean "nothing left to resolve," since the
 * server itself never emits multiple_live_batches for that case. That
 * reasoning is correct about what the SERVER sends, but wrong about what
 * this function was actually being handed: parseConflictingBatches
 * (above) can drop a malformed ENTRY from a genuine two-candidate payload,
 * shrinking the ARRAY to one candidate on THIS client alone. Dropping a
 * malformed description of a batch does not revert that batch — the
 * conflict the server reported is still real. Treating the parse-reduced
 * array as "resolved" cleared the terminal code and (on the plain path)
 * told the operator the conflict had "already been resolved," which was
 * false: retrying hit the identical conflict every time.
 *
 * Corrected: resolution is now decided from `count` — the server's own
 * `conflictingBatchesCount` (batch-service.ts), which is never touched by
 * this client's own parsing — with the array's length used only as a
 * fallback for callers (unit tests, and any legacy caller) that never had
 * a count to carry in the first place, where the array WAS already known
 * to be the complete, authoritative set (e.g. the revert-driven callers
 * below, decrementing from a count this module itself stored at receipt
 * time). It is never used to manufacture "resolved" out of a response this
 * client merely failed to parse in full — see import-client.tsx's
 * handleConfirm and session-step.tsx's sendChunk, which no longer infer
 * resolution from a freshly-received payload's array at all. */
export function isConflictSourceResolved(
  conflictingBatches: ConflictingBatchInfo[] | undefined | null,
  count?: number | null,
): boolean {
  return (count ?? conflictingBatches?.length ?? 0) <= 1;
}
