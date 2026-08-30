// Plain-language summary of a revert's actual outcome, plus the response
// body it reads. Extracted verbatim from import-client.tsx, where both
// were module-private.

/** The revert route's response body (src/app/api/import/batches/[id]/revert/
 * route.ts) — consumed by BatchStep's success panel instead of being
 * discarded (Sol audit 2026-08-27 round 4, finding 3). */
export type RevertResult = {
  revertedCount: number;
  orphanWinesDeleted: number;
  lwinStampsCleared: number;
  cleanupTruncated: boolean;
  orphanCleanupSkipped: boolean;
  /** Sol audit 2026-08-27 round 5, finding 3 — count of every caught
   * cleanup-phase error the revert swallowed (snapshot-read failure,
   * either cleanup step's own top-level catch, or a per-candidate
   * delete/update failure). Independent of `cleanupTruncated`
   * (deadline, not an error) and `orphanCleanupSkipped` (no service
   * client at all, not a request failing). */
  cleanupFailures: number;
};

/** Plain-language summary of a revert's actual outcome, including every
 * way catalog cleanup can come back incomplete (Sol audit 2026-08-27
 * round 4, finding 3 — the response used to be parsed and discarded
 * entirely; round 5, finding 3 — the notices below now COMPOSE instead of
 * an else-if silently dropping one when more than one applies, and
 * `cleanupFailures` gets its own notice). Never suggests reverting again:
 * the batch is already reverted, so — matching docs/runbooks/csv-import.md's
 * own recovery path — the follow-up for a partial cleanup is a manual
 * pass or re-running LWIN matching, not repeating this action. */
export function summarizeRevertResult(result: RevertResult): string {
  const parts = [
    `Removed ${result.revertedCount} inventory row(s) this import created. Where it could safely confirm it, ` +
      `this also deleted ${result.orphanWinesDeleted} wine(s) this import added and cleared ` +
      `${result.lwinStampsCleared} wine-catalog (LWIN) link(s) it wrote — including any link identical to one ` +
      `that existed before the import (re-running LWIN matching restores it if needed).`,
  ];
  // Sol audit round 5, finding 3: these are independent conditions, not
  // mutually exclusive branches — an else-if here would silently drop
  // whichever notice came second when more than one flag is set.
  if (result.orphanCleanupSkipped) {
    parts.push("Orphan-wine cleanup was skipped — service configuration missing. See the CSV import runbook.");
  }
  if (result.cleanupTruncated) {
    parts.push("Catalog cleanup didn't finish in time and was left partial. See the CSV import runbook for the manual follow-up.");
  }
  if (result.cleanupFailures > 0) {
    parts.push("Some cleanup steps failed — see the CSV import runbook.");
  }
  return parts.join(" ");
}
