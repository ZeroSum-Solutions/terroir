// The preview panel's honest CLIENT-SIDE projection of what will actually
// import: the operator's inline fixes counted in, a client-side-skipped
// chunk's rows counted out. Never a claim the server has re-checked
// anything — confirm re-validates every row server-side regardless.
//
// Extracted verbatim from PreviewStep's own render body (import-client.tsx),
// where it could not be exercised without rendering the component.

import { validateFields } from "./row-validator";
import type { ChunkUploadState } from "./chunked-upload-types";
import type { PreviewSummary } from "./preview-service";
import type { ErrorRowEntry, RowOverrides } from "./review-types";

export type PreviewCounts = {
  /** Error rows the operator has edited into passing validation. */
  fixedCount: number;
  canConfirm: boolean;
  effectivePassingValidationRows: number;
  effectiveErrorRows: number;
  /** SD-41: how many rows will actually IMPORT with no producer — the
   * number the operator acknowledges and confirm gates on. Derived exactly
   * like effectivePassingValidationRows (an inline fix counted in, a
   * skipped chunk counted out) rather than read off `summary`, because
   * confirm re-derives its own count WITH the operator's overrides applied
   * and would otherwise disagree with what the checkbox claims. See
   * producer-acknowledgement.ts. */
  effectiveMissingProducerRows: number;
};

export function computePreviewCounts({
  summary,
  errorRows,
  rowOverrides,
  isRowSkipped,
  chunkUpload,
  chunkBreakdown,
}: {
  summary: PreviewSummary;
  errorRows: ErrorRowEntry[];
  rowOverrides: RowOverrides;
  isRowSkipped?: (rowNumber: number) => boolean;
  chunkUpload: ChunkUploadState[] | null;
  chunkBreakdown?: { index: number; summary: PreviewSummary }[];
}): PreviewCounts {
  // A row the operator has edited into passing validation counts toward
  // "ready to confirm" too, even though summary (computed server-side
  // from the ORIGINAL file) has no way to know about it yet — confirm
  // re-validates every row server-side regardless, this only gates the
  // button.
  //
  // Sol round-3 audit (2026-08-27) finding 5: computed over the FULL
  // errorRows list (not just the currently-shown page) so the effective
  // counts below never undercount a fix made on an earlier page before
  // "Show more" was clicked — an override can only exist for a row that
  // was rendered at some point, and shownCount only ever grows (see this
  // component's own comment on `shownCount`), so every fixed row is
  // already included regardless of the current disclosure page.
  //
  // Round-6 audit finding 5: a row belonging to a SKIPPED chunk is
  // excluded here even if its override would otherwise validate — that
  // chunk's rows were never sent, and never will be, so counting a
  // client-side "fix" toward "Passing validation"/the "row(s) fixed"
  // caption below would inflate what's actually going to import.
  const fixedRows = errorRows
    .filter((row) => !isRowSkipped?.(row.rowNumber))
    .map((row) => validateFields({ ...row.rawText, ...rowOverrides[row.rowNumber] }))
    .filter((result) => result.state === "valid");
  const fixedCount = fixedRows.length;
  // SD-41: a row the operator fixed into validity is a row that will now
  // IMPORT — so if the fix left the producer blank, it joins the count
  // confirm gates on. validateFields already decides that (ValidRow.
  // producerMissing), which is the same predicate the server uses.
  const fixedMissingProducerCount = fixedRows.filter(
    (result) => result.state === "valid" && result.producerMissing,
  ).length;
  const canConfirm = summary.validRows > 0 || fixedCount > 0;
  // finding 5: the summary stat tiles below used to render `summary`
  // verbatim — the ORIGINAL server-computed counts, frozen at preview
  // time — so fixing the file's only rejected row still said "Ready to
  // apply: 0, Errors (excluded): 1" even after the row visibly turned
  // "Fixed" and its own copy claimed it would be imported. These are an
  // honest CLIENT-SIDE projection of the same live re-validation
  // RowFixItem already runs, not a claim that the server has re-checked
  // anything yet — confirm always re-validates every row server-side
  // regardless of what's shown here.
  //
  // Round-4 audit finding 3: "Ready to apply" overstated what this number
  // means — a row that passes client-side validateFields can still land
  // in the server's pending bucket (unmatched LWIN, missing cost) or
  // merge into a duplicate at confirm time, so it was never actually
  // guaranteed to "apply." Relabeled to "Passing validation" (see the
  // stat tile below) with an always-visible caption stating plainly that
  // the server decides the final ready/needs-resolution split at import.
  //
  // Round-5 audit finding 5: the VALUE here used to be summary.readyToApplyRows
  // (rows with resolution === 'auto' — schema-valid AND already
  // auto-resolvable) even though the LABEL claims "Passing validation" —
  // so a schema-valid-but-unmatched wine (needs LWIN/cost resolution)
  // counted toward neither tile: "Passing validation: 0, Needs resolution:
  // 1" for a file with exactly one perfectly valid row. Fixed to derive
  // from summary.validRows (every schema-valid row, matching the label's
  // actual claim) plus locally-fixed rows — "Needs resolution" stays its
  // own separate line below, unaffected.
  //
  // Round-7 audit finding 5: summary.validRows is the aggregate across the
  // WHOLE file, computed once at preview time — it has no way to know a
  // chunk was later client-side skipped. A skipped chunk's rows are never
  // sent (isRowInSkippedChunk's own comment) and never will be, so its
  // originally-valid rows must be subtracted out here too, exactly like a
  // skipped chunk's rows are already excluded from fixedRowNumbers above —
  // otherwise "Passing validation" overstates what actually imports by
  // exactly the size of every skipped chunk. chunkBreakdown carries each
  // chunk's own PER-CHUNK PreviewSummary (validRows included) from the
  // same aggregation summary itself was built from, so this is the SAME
  // per-chunk source, not a re-derivation. Undo skip needs no separate
  // handling: this is a live re-derivation from the CURRENT chunkUpload
  // state on every render, so a chunk leaving "skipped" (handleUndoSkip)
  // simply drops out of this sum on the next render, restoring the count.
  const skippedChunks = (chunkUpload ?? []).filter((c) => c.status === "skipped");
  const skippedSum = (key: "validRows" | "missingProducerRows") =>
    skippedChunks.reduce((sum, c) => sum + (chunkBreakdown?.find((cb) => cb.index === c.index)?.summary[key] ?? 0), 0);
  const effectivePassingValidationRows = summary.validRows + fixedCount - skippedSum("validRows");
  const effectiveErrorRows = summary.errorRows - fixedCount;
  // SD-41: same three terms as effectivePassingValidationRows, for exactly
  // the same reasons — a skipped chunk's rows are never sent, so its blank
  // producers are not something to acknowledge.
  const effectiveMissingProducerRows =
    summary.missingProducerRows + fixedMissingProducerCount - skippedSum("missingProducerRows");
  return { fixedCount, canConfirm, effectivePassingValidationRows, effectiveErrorRows, effectiveMissingProducerRows };
}
