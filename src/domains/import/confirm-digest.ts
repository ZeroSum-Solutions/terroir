// Digest construction and recognition for import confirms.
//
// Split out of batch-service.ts, which had grown to 3,478 lines against this
// repo's own 800-line ceiling (docs: rules/devin-stack.md "Small files, small
// functions"). This cluster is the natural first seam: every function here is
// PURE — no Supabase client, no IO, no shared mutable state — so it can be
// read, tested and reasoned about without the confirm/apply/revert machinery
// around it.
//
// Nothing here changed. The functions are byte-identical to their previous
// definitions; only their location did. batch-service.ts re-exports the five
// canonicalize* functions, so every existing import site keeps working
// unchanged and the module's public surface is exactly what it was.

import type { RowOverrides } from "./preview-service";
import { CANONICAL_HEADERS, type CanonicalHeader } from "./constants";

/** Namespace stem for a digest that folds confirm-time extras into the file
 * hash. Shared by every reader and writer of content_sha256 — including
 * migration 0128's SQL, which mirrors this grammar. */
export const OVERRIDES_DIGEST_STEM = "overrides-v";
/** Stable-key-order JSON of a rowOverrides payload, or null when there is
 * nothing to fold into content_sha256 — undefined, or every row's
 * override is an empty field set (both must hash identically to "no
 * overrides at all" so a no-op override never changes a batch's
 * identity). Exported so batch-service.test.ts can pin its exact output
 * independent of the hash itself. */
export function canonicalizeRowOverrides(overrides: RowOverrides | undefined): string | null {
  if (!overrides) return null;
  const rowNumbers = Object.keys(overrides)
    .map(Number)
    .filter((rowNumber) => {
      const fields = overrides[String(rowNumber)];
      return fields && Object.keys(fields).length > 0;
    })
    .sort((a, b) => a - b);
  if (rowNumbers.length === 0) return null;

  const canonical = rowNumbers.map((rowNumber) => {
    const fields = overrides[String(rowNumber)] as Partial<Record<CanonicalHeader, string>>;
    const orderedFields = CANONICAL_HEADERS.filter((field) => fields[field] !== undefined).map(
      (field) => [field, fields[field]] as const,
    );
    return [rowNumber, orderedFields] as const;
  });
  return JSON.stringify(canonical);
}
/** Item 2 — the rejectedLwinRows counterpart to canonicalizeRowOverrides
 * above: stable-order JSON of the rejected-match row-number SET, or null
 * when there is nothing to fold into content_sha256 (undefined, or empty
 * after dedup) — mirroring canonicalizeRowOverrides' own "a no-op collapses
 * to null" contract, so a no-op rejection list never changes a batch's
 * identity either. Exported so batch-service.test.ts can pin its exact
 * output independent of the hash itself. */
export function canonicalizeRejectedLwinRows(rejectedLwinRows: string[] | undefined): string | null {
  if (!rejectedLwinRows) return null;
  const rowNumbers = Array.from(new Set(rejectedLwinRows.map(Number)))
    .filter((n) => Number.isSafeInteger(n) && n >= 1)
    .sort((a, b) => a - b);
  if (rowNumbers.length === 0) return null;
  return JSON.stringify(rowNumbers);
}
/** Sol audit round 3, finding 2 (BLOCK 2) — the approvedLwinRows
 * counterpart to canonicalizeRejectedLwinRows above: stable-order JSON of
 * the operator-approved (row number -> lwin_id) map, or null when there is
 * nothing to fold into content_sha256 (undefined, or empty after
 * dropping malformed entries) — mirroring canonicalizeRowOverrides' and
 * canonicalizeRejectedLwinRows' own "a no-op collapses to null" contract.
 * Duplicate numeric row keys (e.g. "1" and "01" both present, if such a
 * malformed object ever arrived) resolve last-write-wins, matching
 * checkApprovedLwinRows' own Map.set semantics below — this and the bounds
 * check can never canonicalize a different winner for the same malformed
 * input. Exported so batch-service.test.ts can pin its exact output
 * independent of the hash itself. */
export function canonicalizeApprovedLwinRows(approvedLwinRows: Record<string, string> | undefined): string | null {
  if (!approvedLwinRows) return null;
  const byRowNumber = new Map<number, string>();
  for (const [key, lwinId] of Object.entries(approvedLwinRows)) {
    const rowNumber = Number(key);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) continue;
    if (typeof lwinId !== "string" || lwinId.length === 0) continue;
    byRowNumber.set(rowNumber, lwinId);
  }
  if (byRowNumber.size === 0) return null;
  const canonical = Array.from(byRowNumber.entries()).sort(([a], [b]) => a - b);
  return JSON.stringify(canonical);
}
/** Item 2 — folds BOTH canonicalized extras (row-fix overrides, possibly
 * absent, and the rejected-LWIN row set) into ONE deterministic JSON blob
 * for the v2 (rejections-bearing) content_sha256 namespace. Key order is
 * fixed by this object literal's own source order (never client-
 * controlled), so this hashes identically regardless of which extra
 * arrived first over the wire. Exported so batch-service.test.ts can pin
 * its exact output independent of the hash itself. */
export function canonicalizeConfirmExtras(
  overridesCanonicalJson: string | null,
  rejectedLwinRowsCanonicalJson: string | null,
): string {
  return JSON.stringify({
    overrides: overridesCanonicalJson === null ? null : (JSON.parse(overridesCanonicalJson) as unknown),
    rejectedLwinRows:
      rejectedLwinRowsCanonicalJson === null ? null : (JSON.parse(rejectedLwinRowsCanonicalJson) as unknown),
  });
}
/** Sol audit round 3, finding 2 (BLOCK 2) — the v3 (approved-match-bearing)
 * counterpart to canonicalizeConfirmExtras above: folds ALL THREE
 * canonicalized extras into one deterministic JSON blob. A SEPARATE
 * function, not a 3rd optional argument on canonicalizeConfirmExtras —
 * that function's 2-key output shape is the v2 namespace's byte-for-byte
 * contract; adding a third (even null) key to it would change v2's own
 * hash retroactively for every already-existing v2 batch. v3 is only ever
 * used when approvedLwinRowsCanonicalJson is non-null (see
 * confirmImportBatch's own digest-construction comment) — a confirm with
 * no approved-match set at all still hashes via the bare/v1/v2 tiers,
 * completely unchanged. */
export function canonicalizeConfirmExtrasV3(
  overridesCanonicalJson: string | null,
  rejectedLwinRowsCanonicalJson: string | null,
  approvedLwinRowsCanonicalJson: string | null,
): string {
  return JSON.stringify({
    overrides: overridesCanonicalJson === null ? null : (JSON.parse(overridesCanonicalJson) as unknown),
    rejectedLwinRows:
      rejectedLwinRowsCanonicalJson === null ? null : (JSON.parse(rejectedLwinRowsCanonicalJson) as unknown),
    approvedLwinRows:
      approvedLwinRowsCanonicalJson === null ? null : (JSON.parse(approvedLwinRowsCanonicalJson) as unknown),
  });
}
/** Sol round-3 audit (2026-08-27) finding 6: the DB query below can only
 * express "contains fileDigestHex as a LIKE match," which also matches a
 * malformed, multi-colon content_sha256 value engineered to contain the
 * file's own digest as a trailing substring in the right position. Every
 * candidate row is re-checked here against the EXACT formats
 * content_sha256 can ever legitimately hold (see confirmImportBatch's own
 * digest-construction comment) before being treated as a real match.
 *
 * Item 2: the regex's version segment (`[0-9]+`) recognizes ANY namespace
 * version after OVERRIDES_DIGEST_STEM, not just "1" — a hardcoded "1:"
 * here would silently stop recognizing a v2 (rejections-bearing) digest as
 * well-formed, which would fall through isWellFormedDigestForFile's own
 * callers to "not this file," making a rejection-bearing confirm invisible
 * to duplicate/race reconciliation entirely. */
export function isWellFormedDigestForFile(contentSha256: string | null, fileDigestHex: string): boolean {
  if (!contentSha256) return false;
  if (contentSha256 === fileDigestHex) return true;
  return new RegExp(`^${OVERRIDES_DIGEST_STEM}[0-9]+:[0-9a-f]{64}:${fileDigestHex}$`).test(contentSha256);
}
/** Round-7 audit finding 1: the trailing bare-file digest out of either a
 * bare content_sha256 (itself already the file digest) or a well-formed
 * overrides/rejections-namespaced one — the same shapes isWellFormedDigestForFile
 * recognizes, in reverse. Used by findDuplicateBatch's 23505 fallback to
 * recover the fileDigestHex needed to route through the same
 * reconcileLiveBatchesForFile logic the pre-check uses, from a
 * content_sha256 whose format isn't known upfront (unlike confirmImportBatch,
 * which always has fileDigestHex on hand directly from the raw file buffer).
 * Returns null only for a malformed value this product never actually
 * writes — the caller falls back to the pre-existing exact-match behavior
 * in that case, never throws.
 *
 * Item 2: generalized the same way as isWellFormedDigestForFile above —
 * `[0-9]+` recognizes any version, not just "1". */
export function extractFileDigestHex(contentSha256: string): string | null {
  if (/^[0-9a-f]{64}$/.test(contentSha256)) return contentSha256;
  const match = new RegExp(`^${OVERRIDES_DIGEST_STEM}[0-9]+:[0-9a-f]{64}:([0-9a-f]{64})$`).exec(contentSha256);
  return match ? match[1] : null;
}
