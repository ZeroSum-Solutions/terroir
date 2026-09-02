/**
 * Model-based wine-invoice structuring (BND-011).
 *
 * Extracted from /api/scan/route.ts. Two entry points share one call and
 * one error mapping: `extractFromOcr` builds the XML-framed prompt from an
 * Azure OCR result; `extractFromImages` hands the photo (or PDF) to the
 * vision model directly, for when OCR is unavailable (see
 * src/domains/scanning/invoice-extraction-stage.ts). Both return the
 * structured invoice (ParsedInvoice). SDK errors are classified into a
 * small enumeration the route can map to HTTP statuses:
 *
 *   - `not_configured` — OPENROUTER_API_KEY missing. (The singleton
 *     itself throws; we catch and wrap.) Route → 500.
 *   - `parse_failed`   — the model responded but returned no parsed_output,
 *     or the SDK could not parse its structured output against the schema
 *     (a non-API `AnthropicError`; it used to fall through to `unknown`
 *     and a 500). Route → 422 with rawText for manual entry.
 *   - `rate_limited`   — Anthropic.RateLimitError. Route → 429.
 *   - `bad_input`      — Anthropic.BadRequestError. Route → 400.
 *   - `upstream_error` — Anthropic.APIError (not one of the above).
 *     Route → 502.
 *   - `unknown`        — anything else. Route → 500.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import { INVOICE_EXTRACTION, type ModelProfile } from "@/lib/ai/models";
import {
  ParsedInvoiceSchema,
  type ParsedInvoice,
  type ParsedLineItem,
} from "./schema";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { OcrResult } from "./ocr-service";

export type { ParsedInvoice, ParsedLineItem };

export type AiExtractErrorCode =
  | "not_configured"
  | "parse_failed"
  | "validation_failed"
  | "rate_limited"
  | "bad_input"
  | "upstream_error"
  | "unknown";

export class AiExtractError extends Error {
  readonly code: AiExtractErrorCode;
  constructor(code: AiExtractErrorCode, message: string) {
    super(message);
    this.name = "AiExtractError";
    this.code = code;
  }
}

// BND-027: SYSTEM_PROMPT lives in ./system-prompt.ts so the test harness
// at scripts/test-invoices.ts measures the same prompt prod runs.

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build the XML-framed prompt context from an OCR result. Exported for
 *  direct unit testing; the route doesn't call this directly. */
export function buildOcrContext(ocr: OcrResult): string {
  let ocrContext = `<invoice_text>\n${escapeXml(ocr.rawText)}\n</invoice_text>`;
  if (ocr.vendorName) {
    ocrContext += `\n\n<detected_vendor>${escapeXml(ocr.vendorName)}</detected_vendor>`;
  }
  if (ocr.invoiceNumber) {
    ocrContext += `\n\n<detected_invoice_number>${escapeXml(ocr.invoiceNumber)}</detected_invoice_number>`;
  }
  if (ocr.invoiceDate) {
    ocrContext += `\n\n<detected_invoice_date>${escapeXml(ocr.invoiceDate)}</detected_invoice_date>`;
  }
  if (ocr.tables.length > 0) {
    ocrContext += "\n\n<detected_line_items>";
    for (const row of ocr.tables) {
      const parts = [row.description];
      if (row.quantity != null) parts.push(`qty: ${row.quantity}`);
      if (row.unitPrice != null) parts.push(`unit: $${row.unitPrice}`);
      if (row.amount != null) parts.push(`total: $${row.amount}`);
      ocrContext += `\n- ${parts.join(" | ")}`;
    }
    ocrContext += "\n</detected_line_items>";
  }
  return ocrContext;
}

/** The photo pages a vision extraction reads, in order. */
export type InvoicePage = { buffer: Buffer; mimeType: string };

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * @param profile Model profile to run this extraction under. Defaults to
 *   `INVOICE_EXTRACTION`; callers retrying after a failed arithmetic
 *   validation pass `INVOICE_EXTRACTION_RETRY` instead (see
 *   `src/domains/scanning/invoice-arithmetic.ts`).
 */
export async function extractFromOcr(
  ocr: OcrResult,
  profile: ModelProfile = INVOICE_EXTRACTION,
): Promise<ParsedInvoice> {
  return runExtraction(
    buildOcrContext(ocr) +
      "\n\nParse every wine line from this invoice text into the structured output.",
    profile,
  );
}

/**
 * Structure an invoice straight from its photo(s) or PDF, with no OCR text
 * in between. Images go as image blocks, a PDF as a document block, all in
 * one message so a multi-page invoice is read as one document. HEIC/HEIF
 * are refused up front: the vision models cannot read them and Azure was
 * the only stage that could.
 */
export async function extractFromImages(
  pages: InvoicePage[],
  profile: ModelProfile = INVOICE_EXTRACTION,
): Promise<ParsedInvoice> {
  const blocks: Anthropic.Messages.ContentBlockParam[] = pages.map((page) => {
    if (page.mimeType === "application/pdf") {
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: page.buffer.toString("base64") },
      };
    }
    if (!IMAGE_MEDIA_TYPES.has(page.mimeType)) {
      throw new AiExtractError(
        "bad_input",
        "This photo format cannot be read without text recognition. Save it as JPEG or PNG and scan again.",
      );
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: page.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
        data: page.buffer.toString("base64"),
      },
    };
  });
  blocks.push({
    type: "text",
    text: "Parse every wine line on this invoice into the structured output.",
  });
  return runExtraction(blocks, profile);
}

async function runExtraction(
  content: string | Anthropic.Messages.ContentBlockParam[],
  profile: ModelProfile,
): Promise<ParsedInvoice> {
  let client: Anthropic;
  try {
    client = getAnthropicClient();
  } catch {
    throw new AiExtractError(
      "not_configured",
      "Server not configured: OPENROUTER_API_KEY missing.",
    );
  }

  let response;
  try {
    response = await client.messages.parse({
      model: profile.model,
      max_tokens: profile.maxTokens,
      output_config: {
        format: zodOutputFormat(ParsedInvoiceSchema),
        effort: profile.effort,
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      throw new AiExtractError(
        "rate_limited",
        "Rate limited. Wait a minute and try again.",
      );
    }
    if (error instanceof Anthropic.BadRequestError) {
      throw new AiExtractError(
        "bad_input",
        "Could not process this invoice. Try a different photo.",
      );
    }
    if (error instanceof Anthropic.APIError) {
      throw new AiExtractError(
        "upstream_error",
        "The AI service encountered an error. Please try again.",
      );
    }
    // The SDK's own structured-output parse failure is an AnthropicError
    // that is NOT an APIError: the model answered, the answer did not fit
    // the schema. That is a parse failure the user can recover from with
    // the raw text, not an unknown 500. (Guarded: test doubles of the SDK
    // may not define the base class.)
    const BaseError = (Anthropic as unknown as { AnthropicError?: new () => Error }).AnthropicError;
    if (typeof BaseError === "function" && error instanceof BaseError) {
      throw new AiExtractError(
        "parse_failed",
        "Could not structure the invoice. Use the raw text below to enter wines manually.",
      );
    }
    throw new AiExtractError(
      "unknown",
      "Something went wrong processing the invoice.",
    );
  }

  const parsed = response.parsed_output as ParsedInvoice | null | undefined;
  if (!parsed) {
    throw new AiExtractError(
      "parse_failed",
      "Could not structure the invoice. Use the raw text below to enter wines manually.",
    );
  }

  // BND-0087: Explicit Zod validation defense-in-depth gate before any DB write.
  // The SDK messages.parse() already validates against the schema, but an explicit
  // safeParse ensures malformed output is caught and logged before it reaches the DB.
  const validation = ParsedInvoiceSchema.safeParse(parsed);
  if (!validation.success) {
    console.error(
      "[ai-extract] Zod validation failed for model response:",
      validation.error.format(),
    );
    throw new AiExtractError(
      "validation_failed",
      "The AI response did not match the expected format. Please try again.",
    );
  }
  return validation.data;
}
