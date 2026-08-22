import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AiExtractError,
  extractFromOcr,
} from "@/adapters/llm/anthropic-invoice-extraction";
import {
  OcrError,
  extractOcr,
  mergeOcrResults,
  type OcrResult,
} from "@/adapters/ocr/azure-document-intelligence";
import { INVOICE_EXTRACTION, INVOICE_EXTRACTION_RETRY } from "@/lib/ai/models";
import { scoreItems } from "@/lib/scanner/scoring";
import type { LineItem, Scan } from "@/lib/scanner/types";
import type { Database } from "@/types/database";
import { validateInvoiceArithmetic } from "./invoice-arithmetic";
import { withScanSpan } from "./scan-telemetry";

const OCR_STATUS = {
  not_configured: 500,
  empty_text: 422,
  upstream_error: 502,
} as const;

const AI_STATUS = {
  not_configured: 500,
  parse_failed: 422,
  validation_failed: 422,
  rate_limited: 429,
  bad_input: 400,
  upstream_error: 502,
  unknown: 500,
} as const;

export type ProcessInvoiceScanInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  userId: string;
  fileBuffer: Buffer;
  mimeType: string;
  /**
   * Additional pages for a multi-page invoice submitted as several files
   * in one batch (BND-081 / TER-CF-032). Each page is OCR'd independently
   * and the results are merged before Claude extraction. Undefined for
   * the common single-file case.
   */
  extraFiles?: Array<{ buffer: Buffer; mimeType: string }>;
  /** Already-created scanId for the JSON-body path, or null to create fresh. */
  preCreatedScanId?: string;
  /** Storage path for the JSON-body path (already persisted). */
  preUploadedPath?: string;
};

export type ProcessInvoiceScanResult = {
  status: number;
  body: unknown;
};

/**
 * OCR -> LLM extraction -> scoring -> invoice_scan persistence.
 * Route handlers own HTTP lifecycle; this service owns scan domain behavior.
 */
export async function processInvoiceScanOnce(
  input: ProcessInvoiceScanInput,
): Promise<ProcessInvoiceScanResult> {
  const {
    supabase,
    restaurantId,
    userId,
    fileBuffer,
    mimeType,
    extraFiles,
    preCreatedScanId,
    preUploadedPath,
  } = input;

  let scanId = preCreatedScanId ?? "";

  if (!preCreatedScanId) {
    const { data: invScan, error: invErr } = await supabase
      .from("invoice_scans")
      .insert({
        restaurant_id: restaurantId,
        created_by: userId,
        distributor_name: "Unknown",
        parsed_line_items: [],
        final_line_items: [],
        edits: {},
        item_count: 0,
        status: "processing",
      })
      .select("id")
      .single();

    if (invErr || !invScan) {
      console.error("invoice_scans insert failed:", invErr);
      return { status: 500, body: { error: "Failed to create scan record." } };
    }
    scanId = invScan.id;
  }

  let ocr: OcrResult | null = null;

  try {
    const pages = [{ buffer: fileBuffer, mimeType }, ...(extraFiles ?? [])];
    // M1-1: one span per page so a multi-page invoice's OCR fan-out is
    // visible per-page, not just as a single lump sum.
    const ocrResults = await Promise.all(
      pages.map((page, pageIndex) =>
        withScanSpan(
          "ocr.page",
          {
            pageIndex,
            pageCount: pages.length,
            mimeType: page.mimeType,
            byteSize: page.buffer.length,
          },
          () => extractOcr(page.buffer, page.mimeType),
        ),
      ),
    );
    ocr = await withScanSpan(
      "ocr.merge",
      { pageCount: pages.length },
      async () => mergeOcrResults(ocrResults),
    );
    let parsed = await withScanSpan(
      "extract",
      { attempt: 1, model: INVOICE_EXTRACTION.model, effort: INVOICE_EXTRACTION.effort ?? "default" },
      // Non-null: `ocr` was just assigned above; TS can't carry that
      // narrowing through a closure passed to withScanSpan.
      () => extractFromOcr(ocr!),
    );

    if (parsed.lineItems.length === 0) {
      const { error: completionError } = await supabase
        .from("invoice_scans")
        .update({ status: "complete", item_count: 0 })
        .eq("id", scanId);
      if (completionError) throw completionError;
      return {
        status: 422,
        body: {
          scanId,
          code: "no_wines_extracted",
          message: "No wines could be extracted from this image.",
          rawText: ocr.rawText,
        },
      };
    }

    // G1-12: no model should establish financial truth. Deterministic
    // arithmetic validation runs on every fresh extraction; a mismatch gets
    // exactly one retry at higher effort (INVOICE_EXTRACTION_RETRY) before
    // falling back to human review. The retry is a single additional real
    // call — it only fires on a successful-but-inconsistent response, never
    // in response to a transient error, so it can't compound with the
    // Anthropic SDK's own maxRetries or double-bill a flaky upstream.
    let arithmetic = validateInvoiceArithmetic(parsed);
    if (!arithmetic.ok) {
      parsed = await withScanSpan(
        "extract.retry",
        {
          attempt: 2,
          model: INVOICE_EXTRACTION_RETRY.model,
          effort: INVOICE_EXTRACTION_RETRY.effort ?? "default",
        },
        () => extractFromOcr(ocr!, INVOICE_EXTRACTION_RETRY),
      );
      arithmetic = validateInvoiceArithmetic(parsed);
    }

    const parsedAt = new Date().toISOString();
    const items: LineItem[] = parsed.lineItems.map((item, idx) => ({
      id: `${parsedAt}-${idx}`,
      name: item.name,
      producer: item.producer,
      vintage: item.vintage,
      varietal: item.varietal,
      region: item.region,
      qty: item.qty,
      unitCost: item.unitCost,
      lineTotal: item.lineTotal ?? null,
      currency: item.currency ?? null,
      format: item.format ?? null,
      confidence: item.confidence,
      lowFields: item.lowFields.length > 0 ? item.lowFields : undefined,
    })) as LineItem[];

    const quality = scoreItems(items);
    if (!arithmetic.ok) {
      quality.manualFallbackTriggered = true;
      quality.reason = "arithmetic_mismatch";
    }

    const result: Scan = {
      source: {
        distributor: parsed.distributor ?? ocr.vendorName ?? "Unknown",
        invoiceNo: parsed.invoiceNumber ?? ocr.invoiceNumber ?? "—",
        invoiceDate: parsed.invoiceDate ?? ocr.invoiceDate ?? parsedAt.slice(0, 10),
        parsedAt,
      },
      items,
      edits: {},
      quality,
      rawText: ocr.rawText,
      arithmetic,
    };

    const updatePayload: Record<string, unknown> = {
      distributor_name: result.source.distributor,
      invoice_number: result.source.invoiceNo === "—" ? null : result.source.invoiceNo,
      invoice_date: result.source.invoiceDate,
      ocr_text: JSON.parse(JSON.stringify(ocr)),
      parsed_line_items: JSON.parse(JSON.stringify(parsed.lineItems)),
      final_line_items: JSON.parse(JSON.stringify(items)),
      // Arithmetic mismatch overrides the self-reported confidence score:
      // deterministic evidence the numbers don't add up is stronger signal
      // than the model's own confidence, and 0 keeps accuracy_score's
      // existing 0..1 "how much to trust this" semantics rather than adding
      // a new meaning to the column.
      accuracy_score: arithmetic.ok ? (quality.avgConfidence ?? null) : 0,
      item_count: items.length,
      status: arithmetic.ok ? "complete" : "review",
    };
    if (preUploadedPath) {
      updatePayload.raw_image_path = preUploadedPath;
    }
    const { error: completionError } = await withScanSpan(
      "persist",
      { itemCount: items.length, arithmeticOk: arithmetic.ok },
      async () =>
        supabase.from("invoice_scans").update(updatePayload as never).eq("id", scanId),
    );
    if (completionError) throw completionError;

    return { status: 200, body: { scanId, ...result } };
  } catch (error) {
    try {
      await supabase
        .from("invoice_scans")
        .update({ status: "failed" })
        .eq("id", scanId);
    } catch {}

    if (error instanceof OcrError) {
      if (error.code === "upstream_error") {
        Sentry.captureException(error, {
          tags: { stage: "ocr", code: error.code },
          extra: { fileType: mimeType },
        });
      }
      return {
        status: OCR_STATUS[error.code],
        body: { code: error.code, message: error.message },
      };
    }

    if (error instanceof AiExtractError) {
      if (
        error.code === "upstream_error" ||
        error.code === "parse_failed" ||
        error.code === "validation_failed"
      ) {
        Sentry.captureException(error, {
          tags: { stage: "ai-extract", code: error.code },
          extra: { rawTextLen: ocr?.rawText.length },
        });
      }
      const body: { code: string; message: string; rawText?: string } = {
        code: error.code,
        message: error.message,
      };
      if (error.code !== "not_configured" && ocr) {
        body.rawText = ocr.rawText;
      }
      return { status: AI_STATUS[error.code], body };
    }

    throw error;
  }
}
