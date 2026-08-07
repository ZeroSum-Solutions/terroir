import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AiExtractError,
  extractFromOcr,
} from "@/adapters/llm/anthropic-invoice-extraction";
import {
  OcrError,
  extractOcr,
  type OcrResult,
} from "@/adapters/ocr/azure-document-intelligence";
import { scoreItems } from "@/lib/scanner/scoring";
import type { LineItem, Scan } from "@/lib/scanner/types";
import type { Database } from "@/types/database";

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
      console.error("invoice_scans insert failed.");
      return { status: 500, body: { error: "Failed to create scan record." } };
    }
    scanId = invScan.id;
  }

  let ocr: OcrResult | null = null;

  try {
    ocr = await extractOcr(fileBuffer, mimeType);
    const parsed = await extractFromOcr(ocr);

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
      currency: item.currency ?? null,
      format: item.format ?? null,
      confidence: item.confidence,
      lowFields: item.lowFields.length > 0 ? item.lowFields : undefined,
    })) as LineItem[];

    const result: Scan = {
      source: {
        distributor: parsed.distributor ?? ocr.vendorName ?? "Unknown",
        invoiceNo: parsed.invoiceNumber ?? ocr.invoiceNumber ?? "—",
        invoiceDate: parsed.invoiceDate ?? ocr.invoiceDate ?? parsedAt.slice(0, 10),
        parsedAt,
      },
      items,
      edits: {},
      quality: scoreItems(items),
      rawText: ocr.rawText,
    };

    const updatePayload: Record<string, unknown> = {
      distributor_name: result.source.distributor,
      invoice_number: result.source.invoiceNo === "—" ? null : result.source.invoiceNo,
      invoice_date: result.source.invoiceDate,
      ocr_text: JSON.parse(JSON.stringify(ocr)),
      parsed_line_items: JSON.parse(JSON.stringify(parsed.lineItems)),
      final_line_items: JSON.parse(JSON.stringify(items)),
      accuracy_score: result.quality?.avgConfidence ?? null,
      item_count: items.length,
      status: "complete",
    };
    if (preUploadedPath) {
      updatePayload.raw_image_path = preUploadedPath;
    }
    const { error: completionError } = await supabase
      .from("invoice_scans")
      .update(updatePayload as never)
      .eq("id", scanId);
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
