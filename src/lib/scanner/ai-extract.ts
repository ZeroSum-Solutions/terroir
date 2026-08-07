/**
 * Claude-based wine-invoice structuring (BND-011).
 *
 * Extracted from /api/scan/route.ts. Takes the raw OCR result, builds
 * the XML-framed Claude prompt, and returns the structured invoice
 * (ParsedInvoice). Anthropic SDK errors are classified into a small
 * enumeration the route can map to HTTP statuses:
 *
 *   - `not_configured` — ANTHROPIC_API_KEY missing. (The singleton
 *     itself throws; we catch and wrap.) Route → 500.
 *   - `parse_failed`   — Claude responded but returned no parsed_output.
 *     Route → 422 with rawText for manual entry.
 *   - `rate_limited`   — Anthropic.RateLimitError. Route → 429.
 *   - `timeout`        — request deadline or abort. Route → 504.
 *   - `bad_input`      — Anthropic.BadRequestError. Route → 400.
 *   - `upstream_error` — Anthropic.APIError (not one of the above).
 *     Route → 502.
 *   - `unknown`        — anything else. Route → 500.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import {
  ParsedInvoiceSchema,
  type ParsedInvoice,
  type ParsedLineItem,
} from "./schema";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { OcrResult } from "./ocr-service";
import { classifyScannerProviderFailure } from "./provider-failure";

export type { ParsedInvoice, ParsedLineItem };

export type AiExtractErrorCode =
  | "not_configured"
  | "parse_failed"
  | "validation_failed"
  | "rate_limited"
  | "timeout"
  | "bad_input"
  | "upstream_error"
  | "unknown";

export class AiExtractError extends Error {
  readonly code: AiExtractErrorCode;
  readonly retryable: boolean;
  constructor(code: AiExtractErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AiExtractError";
    this.code = code;
    this.retryable = retryable;
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

export async function extractFromOcr(ocr: OcrResult): Promise<ParsedInvoice> {
  let client: Anthropic;
  try {
    client = getAnthropicClient();
  } catch {
    throw new AiExtractError(
      "not_configured",
      "Server not configured: ANTHROPIC_API_KEY missing.",
    );
  }

  const ocrContext = buildOcrContext(ocr);

  let response;
  try {
    response = await client.messages.parse({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      output_config: { format: zodOutputFormat(ParsedInvoiceSchema) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            ocrContext +
            "\n\nParse every wine line from this invoice text into the structured output.",
        },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      throw new AiExtractError(
        "rate_limited",
        "Rate limited. Wait a minute and try again.",
        true,
      );
    }
    if (error instanceof Anthropic.BadRequestError) {
      throw new AiExtractError(
        "bad_input",
        "Could not process this invoice. Try a different photo.",
      );
    }
    const failure = classifyScannerProviderFailure(error);
    if (failure.kind === "timeout") {
      throw new AiExtractError(
        "timeout",
        "The AI service timed out. Please try again.",
        failure.retryable,
      );
    }
    if (error instanceof Anthropic.APIError || failure.kind === "unavailable") {
      throw new AiExtractError(
        "upstream_error",
        "The AI service encountered an error. Please try again.",
        failure.retryable,
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
      "[ai-extract] Zod validation failed for Claude response:",
      validation.error.format(),
    );
    throw new AiExtractError(
      "validation_failed",
      "The AI response did not match the expected format. Please try again.",
    );
  }
  return validation.data;
}
