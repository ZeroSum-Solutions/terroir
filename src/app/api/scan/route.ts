/**
 * POST /api/scan — invoice photo → structured wine scan (BND-011).
 *
 * Thin glue. The three stages live in dedicated modules:
 *   - `extractOcr`     — Azure Document Intelligence wrapper
 *   - `extractFromOcr` — Claude structuring with zod output schema
 *   - `scoreItems`     — pure quality scoring
 *
 * Each stage throws a tagged error (`OcrError` / `AiExtractError`) whose
 * `code` maps 1:1 to an HTTP status. That mapping is the only domain
 * decision this file owns — everything else is request lifecycle.
 */
import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import { requireMembership } from "@/lib/api/auth";
import { AiExtractError, extractFromOcr } from "@/lib/scanner/ai-extract";
import { OcrError, extractOcr } from "@/lib/scanner/ocr-service";
import { scoreItems } from "@/lib/scanner/scoring";
import type { LineItem, Scan } from "@/lib/scanner/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/heic", "image/heif", "application/pdf",
]);
const OCR_STATUS = { not_configured: 500, empty_text: 422, upstream_error: 502 } as const;
const AI_STATUS = {
  not_configured: 500, parse_failed: 422, rate_limited: 429,
  bad_input: 400, upstream_error: 502, unknown: 500,
} as const;

const json = (body: unknown, status: number) => NextResponse.json(body, { status });

export async function POST(request: NextRequest) {
  // ARCH-001: membership gates paid Azure + Anthropic spend.
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;


  // BND-083: storage-path based submission via JSON body
  // Supports submitting a previously-uploaded image by its Supabase storage path.
  const reqContentType = request.headers.get("content-type") ?? "";
  if (reqContentType.includes("application/json") && !reqContentType.includes("multipart")) {
    let jsonBody: { imagePath?: string };
    try { jsonBody = await request.json(); }
    catch { return json({ error: "Invalid JSON body." }, 400); }

    const imagePath = jsonBody.imagePath;
    if (!imagePath) return json({ error: "Missing imagePath field." }, 400);

    const { supabase } = auth;

    // Download image from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("invoice-images")
      .download(imagePath);

    if (downloadError || !fileData) {
      return json({ error: `Image not found: ${downloadError?.message ?? "unknown"}` }, 404);
    }

    const ext = imagePath.split(".").pop()?.toLowerCase() ?? "jpg";
    const mimeType = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : "image/jpeg";
    const fileBuffer = Buffer.from(await fileData.arrayBuffer());

    // Preflight Anthropic config
    try { getAnthropicClient(); }
    catch { return json({ error: "Server not configured: ANTHROPIC_API_KEY missing." }, 500); }

    // Create invoice_scans row with status=processing
    const { data: invoiceScan, error: insertError } = await supabase
      .from("invoice_scans")
      .insert({
        restaurant_id: auth.restaurantId,
        distributor_name: "Unknown",
        parsed_line_items: [],
        final_line_items: [],
        edits: {},
        item_count: 0,
        raw_image_path: imagePath,
        status: "processing",
      })
      .select("id")
      .single();

    if (insertError || !invoiceScan) {
      console.error("invoice_scans insert failed:", insertError);
      return json({ error: "Failed to create scan record." }, 500);
    }

    const scanId = invoiceScan.id;

    try {
      // Stage 1: Azure OCR
      const ocr = await extractOcr(fileBuffer, mimeType);

      // Stage 2: Claude structuring
      const parsed = await extractFromOcr(ocr);

      if (parsed.lineItems.length === 0) {
        await supabase.from("invoice_scans").update({ status: "complete", item_count: 0 }).eq("id", scanId);
        return json({ scanId, code: "no_wines_extracted", message: "No wines could be extracted from this image.", rawText: ocr.rawText }, 422);
      }

      // Stage 3: response assembly
      const parsedAt = new Date().toISOString();
      const items: LineItem[] = parsed.lineItems.map((item, idx) => ({
        id: `${parsedAt}-${idx}`,
        name: item.name, producer: item.producer, vintage: item.vintage,
        varietal: item.varietal, region: item.region, qty: item.qty,
        unitCost: item.unitCost, confidence: item.confidence,
        lowFields: item.lowFields.length > 0 ? item.lowFields : undefined,
      }));

      const result: Scan = {
        source: {
          distributor: parsed.distributor ?? ocr.vendorName ?? "Unknown",
          invoiceNo: parsed.invoiceNumber ?? ocr.invoiceNumber ?? "—",
          invoiceDate: parsed.invoiceDate ?? ocr.invoiceDate ?? parsedAt.slice(0, 10),
          parsedAt,
        },
        items, edits: {}, quality: scoreItems(items), rawText: ocr.rawText,
      };

      // Update row with full results
      await supabase.from("invoice_scans").update({
        distributor_name: result.source.distributor,
        invoice_number: result.source.invoiceNo === "—" ? null : result.source.invoiceNo,
        invoice_date: result.source.invoiceDate,
        parsed_line_items: JSON.parse(JSON.stringify(parsed.lineItems)) as any,
        final_line_items: JSON.parse(JSON.stringify(items)) as any,
        accuracy_score: result.quality.score,
        item_count: items.length,
        status: "complete",
      }).eq("id", scanId);

      return json({ scanId, ...result }, 200);
    } catch (e) {
      // Mark as failed on any pipeline error
      await supabase.from("invoice_scans").update({ status: "failed" }).eq("id", scanId).catch(() => {});
      // Re-throw so existing error handlers catch it
      throw e;
    }
  }

  // Preflight Anthropic config BEFORE Azure — avoid burning OCR spend when
  // we can't finish the pipeline. (BND-010 test invariant.)
  try { getAnthropicClient(); }
  catch { return json({ error: "Server not configured: ANTHROPIC_API_KEY missing." }, 500); }

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return json({ error: "Invalid form data." }, 400); }

  const file = formData.get("file");
  if (!(file instanceof File)) return json({ error: "Attach the invoice as a file under the 'file' field." }, 400);
  if (file.size === 0) return json({ error: "Empty file." }, 400);
  if (file.size > MAX_BYTES) return json({ error: "File exceeds 20 MB." }, 413);
  if (!ALLOWED_MIME.has(file.type)) return json({ error: `Unsupported file type: ${file.type || "unknown"}.` }, 415);

  const fileBuffer = Buffer.from(new Uint8Array(await file.arrayBuffer()));

  // ── Stage 1: Azure OCR ──
  let ocr;
  try { ocr = await extractOcr(fileBuffer, file.type); }
  catch (e) {
    if (e instanceof OcrError) {
      // BND-032 smoke: capture upstream Azure failures (not user-facing
      // misconfig) so they land in Sentry Issues with request context.
      if (e.code === "upstream_error") {
        Sentry.captureException(e, {
          tags: { stage: "ocr", code: e.code },
          extra: { fileType: file.type, fileSize: file.size },
        });
      }
      return json({ error: e.message }, OCR_STATUS[e.code]);
    }
    throw e;
  }

  // ── Stage 2: Claude structuring ──
  let parsed;
  try { parsed = await extractFromOcr(ocr); }
  catch (e) {
    if (e instanceof AiExtractError) {
      // Same pattern: only capture failures that indicate an external
      // problem worth paging on (upstream / parse_failed). Skip rate
      // limits and bad_input — those are expected operational signals.
      if (e.code === "upstream_error" || e.code === "parse_failed") {
        Sentry.captureException(e, {
          tags: { stage: "ai-extract", code: e.code },
          extra: { rawTextLen: ocr.rawText.length },
        });
      }
      const body: { error: string; rawText?: string } = { error: e.message };
      // Surface rawText for every failure except "not configured" so the UI
      // can offer manual entry on the OCR output we already paid for.
      if (e.code !== "not_configured") body.rawText = ocr.rawText;
      return json(body, AI_STATUS[e.code]);
    }
    throw e;
  }

  // Stage 2.5: empty extraction check
  if (parsed.lineItems.length === 0) {
    return json({
      code: "no_wines_extracted",
      message: "No wines could be extracted from this image.",
      rawText: ocr.rawText,
    }, 422);
  }

  // ── Stage 3: response assembly ──
  const parsedAt = new Date().toISOString();
  const items: LineItem[] = parsed.lineItems.map((item, idx) => ({
    id: `${parsedAt}-${idx}`,
    name: item.name, producer: item.producer, vintage: item.vintage,
    varietal: item.varietal, region: item.region, qty: item.qty,
    unitCost: item.unitCost, confidence: item.confidence,
    lowFields: item.lowFields.length > 0 ? item.lowFields : undefined,
  }));

  const scan: Scan = {
    source: {
      distributor: parsed.distributor ?? ocr.vendorName ?? "Unknown",
      invoiceNo: parsed.invoiceNumber ?? ocr.invoiceNumber ?? "—",
      invoiceDate: parsed.invoiceDate ?? ocr.invoiceDate ?? parsedAt.slice(0, 10),
      parsedAt,
    },
    items, edits: {}, quality: scoreItems(items), rawText: ocr.rawText,
  };
  return json(scan, 200);
}
