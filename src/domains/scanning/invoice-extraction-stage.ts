/**
 * The read stage of an invoice scan: OCR when Azure answers, the photo
 * itself when it cannot.
 *
 * The pipeline used to be OCR-or-nothing. With Azure unconfigured (local,
 * staging) or its resource gone (production since #116 — the endpoint no
 * longer resolves) every invoice scan died at the first stage, and the
 * vision models that already read bottle labels were never asked. This
 * stage tries Azure first (multi-page fan-out with one span per page, then
 * a merge), and on `not_configured` or `upstream_error` hands the pages to
 * `extractFromImages` instead — visibly: Sentry gets a warning each time,
 * and the persisted `ocr_text` says `source: "vision"` with no raw text.
 *
 * Not a fallback case: `empty_text`. Azure ran and found nothing to read;
 * a second opinion from a vision model on a blank photo is a guess.
 *
 * Kill switch: `INVOICE_VISION_FALLBACK=off` restores OCR-or-nothing.
 */
import * as Sentry from "@sentry/nextjs";
import {
  extractFromImages,
  extractFromOcr,
  type InvoicePage,
  type ParsedInvoice,
} from "@/adapters/llm/anthropic-invoice-extraction";
import {
  OcrError,
  extractOcr,
  mergeOcrResults,
  type OcrResult,
} from "@/adapters/ocr/azure-document-intelligence";
import type { ModelProfile } from "@/lib/ai/models";
import { withScanSpan } from "./scan-telemetry";

export type InvoiceReadStage = {
  source: "ocr" | "vision";
  /** What gets persisted as `ocr_text` and returned as `rawText`. */
  ocr: OcrResult;
  /** Run (or re-run, with the retry profile) the extraction on this stage's input. */
  extract: (profile?: ModelProfile) => Promise<ParsedInvoice>;
};

const FALLBACK_CODES = new Set(["not_configured", "upstream_error"]);

function fallbackEnabled(): boolean {
  return process.env.INVOICE_VISION_FALLBACK !== "off";
}

export async function readInvoicePages(pages: InvoicePage[]): Promise<InvoiceReadStage> {
  try {
    // M1-1: one span per page so a multi-page invoice's OCR fan-out is
    // visible per-page, not just as a single lump sum.
    const ocrResults = await Promise.all(
      pages.map((page, pageIndex) =>
        withScanSpan(
          "ocr.page",
          { pageIndex, pageCount: pages.length, mimeType: page.mimeType, byteSize: page.buffer.length },
          () => extractOcr(page.buffer, page.mimeType),
        ),
      ),
    );
    const ocr = await withScanSpan("ocr.merge", { pageCount: pages.length }, async () =>
      mergeOcrResults(ocrResults),
    );
    return { source: "ocr", ocr, extract: (profile) => extractFromOcr(ocr, profile) };
  } catch (error) {
    if (!(error instanceof OcrError) || !FALLBACK_CODES.has(error.code) || !fallbackEnabled()) {
      throw error;
    }
    Sentry.captureMessage("Invoice OCR unavailable; extracting from the image directly", {
      level: "warning",
      tags: { stage: "ocr", code: error.code, fallback: "vision" },
      extra: { pageCount: pages.length, reason: error.message },
    });
    const ocr: OcrResult = { rawText: "", tables: [], source: "vision" };
    return { source: "vision", ocr, extract: (profile) => extractFromImages(pages, profile) };
  }
}
