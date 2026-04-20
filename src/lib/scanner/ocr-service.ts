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
