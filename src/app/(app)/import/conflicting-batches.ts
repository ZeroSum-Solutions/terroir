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

/** FINDING 1 (round-15 audit), moved here round-17: the server's own resolved
 * threshold — reconcileLiveBatchesForFile (batch-service.ts) treats
 * `candidates.length <= 1` as nothing left to reconcile, not `=== 0`. With
 * two real candidates, reverting ONE already resolves the conflict
 * server-side. A single source (one chunk's own conflictingBatches, or the
 * plain path's confirmConflictingBatches) is "resolved" the moment it's
 * down to at most one candidate — mirrored here exactly, including for a
 * list that somehow arrives already at length <= 1 (the server never emits
 * multiple_live_batches for that case, but a malformed entry dropped by
 * parseConflictingBatches above can produce exactly that on the CLIENT; if
 * it ever did, this stays coherent rather than blocking on a conflict that
 * has nothing left to resolve).
 *
 * Round-17 audit: moved from import-client.tsx (which re-exports it for
 * backward compatibility) into this neutral module so session-step.tsx's
 * chunk confirm driver can reuse the same threshold without importing a
 * runtime value back from import-client.tsx — that would recreate the
 * import cycle round-15 deliberately broke (see this file's own header
 * comment). import-client.tsx's unresolvedConflictCandidates/
 * applyRevertToChunkUpload still live there since they're plain-path/panel
 * concerns, not shared with session-step.tsx. */
export function isConflictSourceResolved(conflictingBatches: ConflictingBatchInfo[] | undefined | null): boolean {
  return (conflictingBatches?.length ?? 0) <= 1;
}
