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
import { NextResponse,type NextRequest} from "next/server";
import { getAuthContext } from "@/lib/auth-context";
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import { AiExtractError, extractFromOcr } from "@/lib/scanner/ai-extract";
import { scoreItems } from "@/lib/scanner/scoring";
import type { LineItem } from "@/lib/scanner/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const json = (body: unknown, status: number) => NextResponse.json(body, { status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await getAuthContext();
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { supabase, restaurantId } = auth;

  // Fetch the invoice_scans row to get stored OCR text
  const { data: scan, error: fetchErr } = await supabase
    .from("invoice_scans")
    .select("id, ocr_text")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchErr || !scan) {
    return json({ error: "Scan not found." }, 404);
  }

  if (!scan.ocr_text) {
    return json({ error: "Scan has no stored OCR text to re-extract from." }, 422);
  }

  // Preflight Anthropic
  try { getAnthropicClient(); }
  catch { return json({ error: "Server not configured: ANTHROPIC_API_KEY missing." }, 500); }

  // Reconstruct OCR result from stored JSON
  const ocrText = typeof scan.ocr_text === "string"
    ? JSON.parse(scan.ocr_text as string)
    : scan.ocr_text;
  const ocr = ocrText as { rawText: string; vendorName?: string; invoiceNumber?: string; invoiceDate?: string; tables?: unknown[] };

  if (!ocr.rawText) {
    return json({ error: "No OCR text available for re-extraction." }, 422);
  }

  // Stored OCR JSON predates the `tables` field — backfill so the
  // OcrResult contract holds.
  const ocrInput = { ...ocr, tables: ocr.tables ?? [] } as Parameters<typeof extractFromOcr>[0];

  // Re-invoke Claude with the stored OCR text
  let parsed;
  try { parsed = await extractFromOcr(ocrInput); }
  catch (e) {
    if (e instanceof AiExtractError) {
      return json({ error: e.message, rawText: ocr.rawText },
        e.code === "parse_failed" ? 422 : e.code === "rate_limited" ? 429 : 500);
    }
    throw e;
  }

  if (parsed.lineItems.length === 0) {
    return json({
      code: "no_wines_extracted",
      message: "No wines could be extracted from this image.",
      rawText: ocr.rawText,
    }, 422);
  }

  // Assemble new line items
  const parsedAt = new Date().toISOString();
  const items: LineItem[] = parsed.lineItems.map((item, idx) => ({
    id: `${parsedAt}-${idx}`,
    name: item.name, producer: item.producer, vintage: item.vintage,
    varietal: item.varietal, region: item.region, qty: item.qty,
    unitCost: item.unitCost,
    currency: item.currency ?? null,
    format: item.format ?? null,
    confidence: item.confidence,
    lowFields: item.lowFields.length > 0 ? item.lowFields : undefined,
  })) as LineItem[];

  // Update the invoice_scans row with new extraction results
  // NOTE: does NOT mutate existing inventory_items.
  const quality = scoreItems(items);
  try {
    await supabase.from("invoice_scans").update({
      parsed_line_items: JSON.parse(JSON.stringify(parsed.lineItems)),
      final_line_items: JSON.parse(JSON.stringify(items)),
      accuracy_score: quality.avgConfidence,
      item_count: items.length,
    }).eq("id", id);
  } catch {}

  return json({
    scanId: id,
    items,
    quality,
    rawText: ocr.rawText,
  }, 200);
}
