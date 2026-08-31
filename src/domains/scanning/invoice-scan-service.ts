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

/**
 * The machine code persisted to `invoice_scans.status_reason` when a scan
 * fails (0143). Prefixed by stage so the ledger says WHERE it broke, not
 * only that it did; `src/lib/scanner/scan-status-reason.ts` renders these
 * as prose.
 */
function failureReason(error: unknown): string {
  if (error instanceof OcrError) return `ocr_${error.code}`;
  if (error instanceof AiExtractError) return `ai_${error.code}`;
  return "unexpected_error";
}

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
      // SCAN-04 / D6 rule 1: this row stays in the ledger forever, so it
      // has to be able to say why it is empty. Without status_reason a
      // 0-item "complete" scan and a 0-item "failed" scan render
      // identically, which is the confusion the decision names.
      const { error: completionError } = await supabase
        .from("invoice_scans")
        .update({ status: "complete", item_count: 0, status_reason: "no_wines_extracted" })
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
      try {
        const retryParsed = await withScanSpan(
          "extract.retry",
          {
            attempt: 2,
            model: INVOICE_EXTRACTION_RETRY.model,
            effort: INVOICE_EXTRACTION_RETRY.effort ?? "default",
          },
          () => extractFromOcr(ocr!, INVOICE_EXTRACTION_RETRY),
        );
        // Grok-3: an empty retry is not a reconciling result — it's the
        // model finding nothing on a second pass. Adopting it would
        // discard the first (non-empty, merely arithmetic-inconsistent)
        // extraction and persist a wine-free "complete" scan. Keep the
        // first parsed result and let its already-failing arithmetic
        // route to the human-review path below instead.
        if (retryParsed.lineItems.length > 0) {
          parsed = retryParsed;
          arithmetic = validateInvoiceArithmetic(parsed);
        }
      } catch (retryError) {
        // Grok-4: a transient retry failure (rate limit, upstream error,
        // parse failure) must not discard a usable first extraction. Per
        // the G1-12 design, an unreconciled extraction already falls back
        // to human review — a failed retry is just another way to land
        // there, not a reason to fail the whole scan. First-attempt
        // errors are unaffected: this catch only wraps the retry call.
        console.error("extract.retry failed; falling back to first extraction:", retryError);
        Sentry.captureException(retryError, {
          tags: {
            stage: "ai-extract-retry",
            code: retryError instanceof AiExtractError ? retryError.code : "unknown",
          },
        });
      }
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
      // D6 rule 1 again: "review" is a state the operator has to act on,
      // so the ledger states which deterministic check put it there.
      status_reason: arithmetic.ok ? null : "arithmetic_mismatch",
    };
    if (preUploadedPath) {
      updatePayload.raw_image_path = preUploadedPath;
    }
    // Grok-2: fenced on the row still being 'processing' — a worker
    // reclaimed mid-call (see heartbeat.ts: renewal failures are
    // best-effort) must never clobber a result another worker's attempt
    // already persisted (complete/review). `.select("id")` lets us detect
    // whether the fence actually matched.
    const { data: persistedRows, error: completionError } = await withScanSpan(
      "persist",
      { itemCount: items.length, arithmeticOk: arithmetic.ok },
      async () =>
        supabase
          .from("invoice_scans")
          .update(updatePayload as never)
          .eq("id", scanId)
          .eq("status", "processing")
          .select("id"),
    );
    if (completionError) throw completionError;
    if (!persistedRows || persistedRows.length === 0) {
      return {
        status: 409,
        body: {
          scanId,
          code: "scan_superseded",
          message: "Scan was already completed by another worker attempt.",
        },
      };
    }

    return { status: 200, body: { scanId, ...result } };
  } catch (error) {
    try {
      // Grok-2: fenced the same way as the success persist above — a
      // stale worker's failure write must never overwrite a result
      // another worker's attempt already persisted.
      //
      // C04 (db audit 2026-08-23): if OCR already succeeded before the
      // failure (e.g. the LLM extraction call itself threw), persist the
      // ocr_text we already paid for. Without this, a 'failed' scan has
      // no recovery path at all: ocr_text is otherwise written only by
      // the success branch above, and POST /api/scans/[id]/re-extract
      // requires ocr_text to be non-null (422 missing_ocr_text) — so a
      // transient extraction failure on an otherwise-successful OCR pass
      // was previously a permanent dead end for the app's own re-extract
      // affordance (src/app/(app)/scan/[id]/components/re-extract-button.tsx).
      // An OCR-stage failure still has nothing to persist and stays a
      // genuine terminal failure, which is correct.
      const failurePayload: Record<string, unknown> = {
        status: "failed",
        // D6 rule 1: a failed scan stays in the ledger, so it carries the
        // stage and code that failed rather than a bare "Failed" badge.
        status_reason: failureReason(error),
      };
      if (ocr) {
        failurePayload.ocr_text = JSON.parse(JSON.stringify(ocr));
      }
      await supabase
        .from("invoice_scans")
        .update(failurePayload as never)
        .eq("id", scanId)
        .eq("status", "processing");
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
