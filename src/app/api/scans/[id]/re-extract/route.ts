/**
 * POST /api/scans/[id]/re-extract — BND-097
 *
 * Re-invokes Claude extraction using the stored OCR text from an
 * invoice_scans row. Useful when Claude misread the original scan.
 *
 * The existing invoice_scans row is updated with the new extraction results.
 * Original committed inventory_items are NOT mutated — only the
 * invoice_scans parsed_/final_line_items are refreshed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError, Errors } from "@/lib/api/errors";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import { INVOICE_EXTRACTION_RETRY } from "@/lib/ai/models";
import { AiExtractError, extractFromOcr } from "@/lib/scanner/ai-extract";
import {
  ScanIdParamsSchema,
  StoredOcrSchema,
} from "@/lib/scanner/request-schemas";
import { scoreItems } from "@/lib/scanner/scoring";
import type { LineItem } from "@/lib/scanner/types";
import { validateInvoiceArithmetic } from "@/domains/scanning/invoice-arithmetic";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Maps an extraction failure to the route's HTTP response. Shared between
 * the initial extraction call and the G1-12 arithmetic-mismatch retry so
 * both attempts fail the same way. Rethrows anything that isn't a mapped
 * `AiExtractError` code (including non-AiExtractError values).
 */
function mapExtractError(error: unknown, rawText: string) {
  if (!(error instanceof AiExtractError)) throw error;
  if (error.code === "parse_failed" || error.code === "validation_failed") {
    return apiError(
      422,
      error.code,
      "Unable to extract wines from stored OCR.",
      { rawText },
    );
  }
  if (error.code === "rate_limited") {
    return Errors.rateLimited("Extraction provider rate limited.");
  }
  if (error.code === "bad_input") {
    return Errors.badRequest(
      "Stored OCR could not be processed.",
      undefined,
      "bad_input",
    );
  }
  if (error.code === "upstream_error") {
    return Errors.badGateway("Extraction provider unavailable.");
  }
  throw error;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ScanIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: scan, error: fetchError } = await supabase
      .from("invoice_scans")
      .select("id, ocr_text")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .single();
    if (fetchError && (fetchError as { code?: string }).code !== "PGRST116") {
      throw fetchError;
    }
    if (!scan) return Errors.notFound("Scan");

    let rawOcr: unknown = scan.ocr_text;
    if (rawOcr === null || rawOcr === undefined) {
      return Errors.unprocessable(
        "missing_ocr_text",
        "Scan has no stored OCR text to re-extract.",
      );
    }
    if (typeof rawOcr === "string") {
      try {
        rawOcr = JSON.parse(rawOcr);
      } catch {
        throw new Error("Stored OCR JSON is malformed.");
      }
    }
    const parsedOcr = StoredOcrSchema.safeParse(rawOcr);
    if (!parsedOcr.success) {
      return Errors.unprocessable(
        "invalid_ocr_text",
        "Scan has no valid OCR text to re-extract.",
      );
    }
    const ocr = parsedOcr.data;

    let parsed;
    try {
      parsed = await extractFromOcr(ocr);
    } catch (error) {
      return mapExtractError(error, ocr.rawText);
    }

    if (parsed.lineItems.length === 0) {
      return apiError(
        422,
        "no_wines_extracted",
        "No wines could be extracted from the stored OCR.",
        { rawText: ocr.rawText },
      );
    }

    // G1-12: same deterministic arithmetic gate as the initial scan pass —
    // re-extraction is still model output flowing toward persistence, so it
    // gets the same one retry at higher effort before falling back to human
    // review. See src/domains/scanning/invoice-scan-service.ts for the fuller
    // rationale; errors from the retry call propagate to the same catch
    // block above as the first call, so this can't compound retries.
    let arithmetic = validateInvoiceArithmetic(parsed);
    if (!arithmetic.ok) {
      try {
        parsed = await extractFromOcr(ocr, INVOICE_EXTRACTION_RETRY);
      } catch (error) {
        return mapExtractError(error, ocr.rawText);
      }
      arithmetic = validateInvoiceArithmetic(parsed);
    }

    const parsedAt = new Date().toISOString();
    const items: LineItem[] = parsed.lineItems.map((item, index) => ({
      id: `${parsedAt}-${index}`,
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

    const { error: updateError } = await supabase
      .from("invoice_scans")
      .update({
        parsed_line_items: JSON.parse(JSON.stringify(parsed.lineItems)),
        final_line_items: JSON.parse(JSON.stringify(items)),
        accuracy_score: arithmetic.ok ? quality.avgConfidence : 0,
        item_count: items.length,
        status: arithmetic.ok ? "complete" : "review",
      })
      .eq("id", id)
      .eq("restaurant_id", restaurantId);
    if (updateError) throw updateError;

    return NextResponse.json({
      scanId: id,
      items,
      quality,
      arithmetic,
      rawText: ocr.rawText,
    });
  });
}
