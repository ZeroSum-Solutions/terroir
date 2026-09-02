/**
 * Azure Document Intelligence wrapper (BND-011).
 *
 * Extracted from /api/scan/route.ts. Owns the three Azure-related
 * failure modes that /api/scan cares about:
 *
 *   - `not_configured` — AZURE_DOC_INTELLIGENCE_{ENDPOINT,KEY} missing.
 *     The route maps this to 500 and a user-friendly message.
 *   - `upstream_error` — `analyzeInvoice` rejected. Mapped to 502.
 *   - `empty_text`    — OCR succeeded but `rawText` was blank. Mapped
 *     to 422 with a "sharper photo" prompt.
 *
 * Every other Azure concern (buffer conversion, mime classification)
 * stays on the route because it's request-lifecycle-specific.
 */
import { analyzeInvoice } from "./azure";

export type OcrTable = {
  description: string;
  quantity?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
};

export type OcrResult = {
  rawText: string;
  /** Where the text came from. Absent means Azure; "vision" means no OCR ran
   *  and the model read the photo directly (invoice-extraction-stage.ts). */
  source?: "vision";
  vendorName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  tables: OcrTable[];
};

export type OcrErrorCode = "not_configured" | "upstream_error" | "empty_text";

export class OcrError extends Error {
  readonly code: OcrErrorCode;
  constructor(code: OcrErrorCode, message: string) {
    super(message);
    this.name = "OcrError";
    this.code = code;
  }
}

export async function extractOcr(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<OcrResult> {
  if (
    !process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT ||
    !process.env.AZURE_DOC_INTELLIGENCE_KEY
  ) {
    throw new OcrError(
      "not_configured",
      "Invoice scanning is not configured. Please contact support.",
    );
  }

  let result: OcrResult;
  try {
    result = (await analyzeInvoice(fileBuffer, mimeType)) as OcrResult;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Azure OCR failed.";
    throw new OcrError("upstream_error", message);
  }

  if (!result.rawText.trim()) {
    throw new OcrError(
      "empty_text",
      "Could not extract text from the invoice. The image may be blank or unreadable — try a sharper photo.",
    );
  }

  return result;
}

/**
 * Merge per-page OCR results into one document for extraction (BND-081 /
 * TER-CF-032 — multi-page invoice submitted as multiple images/files in
 * one batch). Text and tables are concatenated in page order; header
 * fields (vendor/invoice number/date) typically only appear on the first
 * page, so the first page that has each field wins.
 *
 * A single-page result is returned as-is (no allocation, no formatting
 * change) so the overwhelmingly common single-file scan is unaffected.
 */
export function mergeOcrResults(results: OcrResult[]): OcrResult {
  if (results.length === 1) return results[0];

  return {
    rawText: results.map((r) => r.rawText).join("\n\n"),
    tables: results.flatMap((r) => r.tables),
    vendorName: results.find((r) => r.vendorName)?.vendorName,
    invoiceNumber: results.find((r) => r.invoiceNumber)?.invoiceNumber,
    invoiceDate: results.find((r) => r.invoiceDate)?.invoiceDate,
  };
}
