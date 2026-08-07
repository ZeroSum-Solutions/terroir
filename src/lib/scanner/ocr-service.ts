/**
 * Azure Document Intelligence wrapper (BND-011).
 *
 * Extracted from /api/scan/route.ts. Owns the three Azure-related
 * failure modes that /api/scan cares about. Provider exceptions are reduced to
 * a fixed, redacted retry taxonomy before they cross this boundary:
 *
 *   - `not_configured` — AZURE_DOC_INTELLIGENCE_{ENDPOINT,KEY} missing.
 *     The route maps this to 500 and a user-friendly message.
 *   - `rate_limited` / `timeout` / `bad_input` / `upstream_error` / `unknown`
 *     — classified provider failures with fixed public messages.
 *   - `empty_text`    — OCR succeeded but `rawText` was blank. Mapped
 *     to 422 with a "sharper photo" prompt.
 *
 * Every other Azure concern stays at the provider adapter boundary.
 */
import { analyzeInvoice } from "./azure";
import { classifyScannerProviderFailure } from "./provider-failure";

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

export type OcrErrorCode =
  | "not_configured"
  | "rate_limited"
  | "timeout"
  | "bad_input"
  | "upstream_error"
  | "unknown"
  | "empty_text";

export class OcrError extends Error {
  readonly code: OcrErrorCode;
  readonly retryable: boolean;
  constructor(code: OcrErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "OcrError";
    this.code = code;
    this.retryable = retryable;
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
    const failure = classifyScannerProviderFailure(error);
    if (failure.kind === "rate_limited") {
      throw new OcrError(
        "rate_limited",
        "Invoice text extraction is rate limited. Please try again shortly.",
        failure.retryable,
      );
    }
    if (failure.kind === "timeout") {
      throw new OcrError(
        "timeout",
        "Invoice text extraction timed out. Please try again.",
        failure.retryable,
      );
    }
    if (failure.kind === "bad_input") {
      throw new OcrError(
        "bad_input",
        "The invoice could not be processed. Try a clearer image or PDF.",
        failure.retryable,
      );
    }
    if (failure.kind === "unavailable") {
      throw new OcrError(
        "upstream_error",
        "Invoice text extraction is temporarily unavailable. Please try again.",
        failure.retryable,
      );
    }
    throw new OcrError(
      "upstream_error",
      "Invoice text extraction is temporarily unavailable. Please try again.",
      false,
    );
  }

  if (!result.rawText.trim()) {
    throw new OcrError(
      "empty_text",
      "Could not extract text from the invoice. The image may be blank or unreadable — try a sharper photo.",
    );
  }

  return result;
}
