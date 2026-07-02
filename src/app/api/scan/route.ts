/**
 * POST /api/scan — invoice photo → structured wine scan (BND-011).
 *
 * Thin orchestration. Request parsing, auth, rate limits, idempotency, and
 * post-success storage upload live here; OCR, LLM extraction, scoring, and
 * invoice_scan persistence live in the scanning domain service.
 *
 * BND-089: Idempotency via `Idempotency-Key` header. Wraps processing in
 * `withIdempotency` so retries return the cached response without
 * re-running Azure OCR or Claude extraction.
 */
import { NextResponse, type NextRequest } from "next/server";
import { assertInvoiceExtractionConfigured } from "@/adapters/llm/anthropic-invoice-extraction";
import { processInvoiceScanOnce } from "@/domains/scanning/invoice-scan-service";
import { rateLimit } from "@/lib/api/rate-limit";
import { requireMembership } from "@/lib/api/auth";
import { withIdempotency, isValidIdempotencyKey } from "@/lib/api/idempotency";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Max scan requests per restaurant per minute. */
const SCAN_RATE_LIMIT = 10;
/** Rate-limit window in ms (one minute). */
const SCAN_RATE_WINDOW_MS = 60 * 1000;

/**
 * Best-effort client-IP extraction. Uses x-forwarded-for or x-real-ip.
 */
function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/heic", "image/heif", "application/pdf",
]);

const json = (body: unknown, status: number) =>
  NextResponse.json(body, { status });

export async function POST(request: NextRequest) {
  // ARCH-001: membership gates paid Azure + Anthropic spend.
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;

  const { supabase, user, restaurantId } = auth;

  // INT-003: rate-limit scans per restaurant to control Azure + Anthropic spend.
  // Keyed per restaurant so a single restaurant can't burn through the budget.
  const limit = rateLimit(
    `scan:${restaurantId}:${clientIp(request)}`,
    SCAN_RATE_LIMIT,
    SCAN_RATE_WINDOW_MS,
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many scan requests. Please wait before scanning again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  // BND-089: extract idempotency key before any processing.
  const rawKey = request.headers.get("Idempotency-Key");
  const idempotencyKey = isValidIdempotencyKey(rawKey) ? rawKey : null;

  // Preflight Anthropic config BEFORE Azure — avoid burning OCR spend when
  // we can't finish the pipeline. Also runs before the idempotency claim
  // so a missing key is a fast 500 without touching the DB.
  try {
    assertInvoiceExtractionConfigured();
  } catch {
    return json(
      { error: "Server not configured: ANTHROPIC_API_KEY missing." },
      500,
    );
  }

  // ── JSON body path (BND-083: storage-path based submission) ─────────
  const reqContentType = request.headers.get("content-type") ?? "";
  if (
    reqContentType.includes("application/json") &&
    !reqContentType.includes("multipart")
  ) {
    let jsonBody: { imagePath?: string };
    try {
      jsonBody = await request.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }

    const imagePath = jsonBody.imagePath;
    if (!imagePath) return json({ error: "Missing imagePath field." }, 400);

    // Download image from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("invoice-images")
      .download(imagePath);

    if (downloadError || !fileData) {
      return json({ error: `Image not found: ${downloadError?.message ?? "unknown"}` }, 404);
    }

    const ext = imagePath.split(".").pop()?.toLowerCase() ?? "jpg";
    const mimeType =
      ext === "pdf"
        ? "application/pdf"
        : ext === "png"
          ? "image/png"
          : ext === "heic"
            ? "image/heic"
            : ext === "heif"
              ? "image/heif"
              : "image/jpeg";
    const fileBuffer = Buffer.from(await fileData.arrayBuffer());

    // BND-105: reject unsupported file types in JSON body path too.
    const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "heic", "heif", "pdf"]);
    if (!ALLOWED_EXT.has(ext)) {
      return json({
        code: "unsupported_type",
        error:
          "Unsupported file type: ." + ext + ". Allowed: jpeg, png, heic, pdf.",
      }, 415);
    }

    if (fileBuffer.length > MAX_BYTES) return json({ error: "File exceeds 10 MB." }, 413);

    // Create invoice_scans row BEFORE the idempotency handler so the scanId
    // is stable. On replay the handler won't run, so the row is harmless.
    const { data: invoiceScan, error: insertError } = await supabase
      .from("invoice_scans")
      .insert({
        restaurant_id: restaurantId,
        created_by: user.id,
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

    const preCreatedScanId = invoiceScan.id;

    const result = await withIdempotency({
      supabase,
      restaurantId,
      key: idempotencyKey,
      handler: () =>
        processInvoiceScanOnce({
          supabase,
          restaurantId,
          userId: user.id,
          fileBuffer,
          mimeType,
          preCreatedScanId,
          preUploadedPath: imagePath,
        }),
    });

    return json(result.body, result.status);
  }

  // ── Form-data path ──────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Invalid form data." }, 400);
  }

  const files = formData.getAll("file");
  if (files.length === 0) return json({ error: "No file attached." }, 400);
  const firstEntry = files[0];
  if (!(firstEntry instanceof File)) return json({ error: "Invalid file." }, 400);
  const file: File = firstEntry;
  if (file.size === 0) return json({ error: "Empty file." }, 400);
  if (file.size > MAX_BYTES) return json({ error: "File exceeds 10 MB." }, 413);
  if (!ALLOWED_MIME.has(file.type)) {
    return json(
      {
        code: "unsupported_type",
        error: "Unsupported file type: " + (file.type || "unknown") + ".",
      },
      415,
    );
  }

  const fileBuffer = Buffer.from(new Uint8Array(await file.arrayBuffer()));

  // BND-089: wrap the scan in idempotency so retries return the cached
  // result without re-running Azure OCR or Claude extraction.
  const result = await withIdempotency({
    supabase,
    restaurantId,
    key: idempotencyKey,
    handler: () =>
      processInvoiceScanOnce({
        supabase,
        restaurantId,
        userId: user.id,
        fileBuffer,
        mimeType: file.type,
      }),
  });

  // BND-080/BND-081: upload images to Supabase Storage under restaurant
  // prefix AFTER processing (only on first request, not replay).
  if (!result.replayed && result.status === 200) {
    const scanId = (result.body as { scanId?: string }).scanId;
    if (scanId) {
      const extraPaths: string[] = [];
      let pageIdx = 0;
      while (pageIdx !== files.length) {
        const pageFile = files[pageIdx];
        pageIdx++;
        if (!(pageFile instanceof File)) {
          /* skip non-file entries */
        } else {
          const pageExt = pageFile.type === "application/pdf" ? "pdf" : pageFile.type === "image/png" ? "png" : "jpg";
          const pageTag = files.length !== 1 ? "_page" + pageIdx : "";
          const pagePath = restaurantId + "/" + scanId + pageTag + "." + pageExt;
          const pageBuf = Buffer.from(new Uint8Array(await pageFile.arrayBuffer()));
          const pageRes = await supabase.storage
            .from("invoice-images")
            .upload(pagePath, pageBuf, {
              contentType: pageFile.type,
              upsert: true,
            });
          if (!pageRes.error) {
            if (pageIdx === 1) {
              await supabase
                .from("invoice_scans")
                .update({ raw_image_path: pagePath })
                .eq("id", scanId);
            } else {
              extraPaths.push(pagePath);
            }
          }
        }
      }
      if (extraPaths.length !== 0) {
        await supabase.from("invoice_scans").update({ extra_image_paths: extraPaths }).eq("id", scanId);
      }
    }
  }

  return json(result.body, result.status);
}
