// SCAN-04 / decision D6 rule 1: "a scan that returns zero items, or fails,
// stays in the ledger, visible, WITH A STATED REASON."
//
// `invoice_scans.status_reason` (migration 0143) holds a short machine code.
// This is the one place it becomes prose, so the scan list, the scan detail
// page and the delete confirmation can never disagree about what a code
// means. Codes are written by src/domains/scanning/invoice-scan-service.ts
// (`no_wines_extracted`, `arithmetic_mismatch`, `ocr_*`, `ai_*`) and by
// POST /api/inventory/save-scan (`inventory_save_failed`).

const REASONS: Record<string, string> = {
  no_wines_extracted:
    "No wine lines could be read from this image. The scan is kept so you can re-extract it or replace the photo.",
  arithmetic_mismatch:
    "The extracted numbers don’t add up. Review and correct the flagged lines before saving to inventory.",
  inventory_save_failed:
    "The extraction succeeded but saving it to inventory failed. Nothing was added; open the scan and save again.",
  ocr_not_configured: "Text recognition is not configured on this deployment.",
  ocr_empty_text: "Text recognition found no readable text in this image.",
  ocr_upstream_error: "The text-recognition service failed. Try scanning again.",
  ai_not_configured: "Line-item extraction is not configured on this deployment.",
  ai_parse_failed: "The extracted response could not be read as line items.",
  ai_validation_failed: "The extracted line items failed validation.",
  ai_rate_limited: "The extraction service was rate-limited. Try again in a minute.",
  ai_bad_input: "This image could not be used for extraction.",
  ai_upstream_error: "The extraction service failed. Try scanning again.",
  ai_unknown: "Extraction failed for an unrecognised reason.",
  unexpected_error: "The scan failed unexpectedly. Try scanning again.",
  // Written by src/domains/scanning/stalled-scans.ts when a row has sat in
  // "processing" longer than any synchronous scan can live.
  stalled: "The scan did not finish — the server stopped mid-way. Scan it again.",
};

/**
 * Prose for a persisted status_reason, or null when there is nothing to
 * say. An UNKNOWN code is deliberately surfaced verbatim rather than
 * swallowed: a row that carries a reason must always be able to state one,
 * even if a newer writer invented the code after this map was last edited.
 */
export function describeScanStatusReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASONS[reason] ?? `Reason recorded as “${reason}”.`;
}
