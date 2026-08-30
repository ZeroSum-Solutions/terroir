// The plain (<= MAX_ROWS) path's two network calls — the counterpart to
// chunked-preview.ts / chunked-confirm.ts for a file that previews and
// confirms as a single unit. Extracted verbatim from ImportClient's own
// runSingleFilePreview/handleConfirm (import-client.tsx), where the request
// payload could only be exercised by driving the component.

import { buildApprovedLwinRows, matchedRowsFromPreviewRows } from "./lwin-approval";
import type { PreviewRow, PreviewSummary } from "./preview-service";
import type { RejectedLwinRows, RowOverrides } from "./review-types";

export type SingleFilePreviewResult =
  | { ok: true; preview: { rows: PreviewRow[]; summary: PreviewSummary } }
  | { ok: false; error: string };

export async function requestSingleFilePreview(file: File): Promise<SingleFilePreviewResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/import/preview", { method: "POST", body: form });
  const body = await response.json();
  if (!response.ok) return { ok: false, error: body?.error?.message ?? "Preview failed." };
  return { ok: true, preview: body };
}

export type SingleFileConfirmResult = { ok: true; batchId: string } | { ok: false; error: string };

export async function confirmSingleFileImport({
  file,
  rowOverrides,
  rejectedLwinRows,
  previewRows,
}: {
  file: File;
  rowOverrides: RowOverrides;
  rejectedLwinRows: RejectedLwinRows;
  /** The rows the operator was actually shown, or null when preview never
   * produced any (the chunked path owns its own confirm). */
  previewRows: PreviewRow[] | null;
}): Promise<SingleFileConfirmResult> {
  const form = new FormData();
  form.append("file", file);
  if (Object.keys(rowOverrides).length > 0) {
    form.append("rowOverrides", JSON.stringify(rowOverrides));
  }
  if (rejectedLwinRows.size > 0) {
    form.append("rejectedLwinRows", JSON.stringify(Array.from(rejectedLwinRows)));
  }
  // BLOCK 2 (Sol audit round 3, finding 2): echo back the lwin_id
  // shown for every currently-linking matched row, so confirm's own
  // re-match can veto a disagreeing catalogue tie instead of silently
  // persisting it — see buildApprovedLwinRows' own comment.
  //
  // BLOCK 1 (round 5 fix): ALWAYS send this field, even as `{}` for a
  // file with zero linking matches — its mere PRESENCE tells confirm
  // this client showed the operator its full linking picture, so
  // applyLwinApprovalVeto (batch-service.ts) can fail closed on any
  // row absent from it. Gating this on non-emptiness (the old
  // behavior) made an all-non-linking file's confirm indistinguishable
  // from an older client that never sends this at all — exactly the
  // ambiguity that let a row re-scoring above the apply threshold
  // between preview and confirm sail through unvetoed.
  if (previewRows) {
    const approvedLwinRows = buildApprovedLwinRows(matchedRowsFromPreviewRows(previewRows));
    form.append("approvedLwinRows", JSON.stringify(approvedLwinRows));
  }
  const response = await fetch("/api/import/batches", { method: "POST", body: form });
  const body = await response.json();
  if (!response.ok) {
    // Round-27 audit (removes the in-preview conflict-recovery panel):
    // the server's own message is the only guidance shown for a
    // conflict — no client-side escalation, no invented terminal state.
    // A multiple_live_batches conflict or a duplicate_race_retry stays
    // retryable exactly like any other failure; recovery for the
    // former is through Recent imports.
    return { ok: false, error: body?.error?.message ?? "Import could not be created." };
  }
  return { ok: true, batchId: body.batchId as string };
}
