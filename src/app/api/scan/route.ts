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
import { z } from "zod";
import { assertInvoiceExtractionConfigured } from "@/adapters/llm/anthropic-invoice-extraction";
import { processInvoiceScanOnce } from "@/domains/scanning/invoice-scan-service";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { rateLimit } from "@/lib/api/rate-limit";
import { requireMembership } from "@/lib/api/auth";
import { withIdempotency, isValidIdempotencyKey } from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import {
  fileField,
  parseJson,
  parseMultipart,
} from "@/lib/api/validation";
import { InvoicePathBodySchema } from "@/lib/scanner/request-schemas";

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
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["application/pdf", "pdf"],
]);
const ALLOWED_MIME = new Set(MIME_EXTENSIONS.keys());

const InvoiceFilesSchema = z.object({
  file: z
    .union([fileField, z.array(fileField).min(1)])
    .transform((value) => (Array.isArray(value) ? value : [value])),
});

function isStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: string;
    error?: string;
    status?: number;
    statusCode?: number | string;
  };
  return (
    value.status === 404 ||
    value.statusCode === 404 ||
    value.statusCode === "404" ||
    value.code === "404" ||
    value.code === "not_found" ||
    value.error === "not_found"
  );
}

export async function POST(request: NextRequest) {
  return withApiHandler(() => postInvoiceScan(request));
}

async function postInvoiceScan(request: NextRequest) {
  // ARCH-001: membership gates paid Azure + Anthropic spend.
  const auth = await requireMembership({ rateLimit: "expensive" });
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
    return Errors.rateLimited(
      "Too many scan requests. Please wait before scanning again.",
      { headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  // BND-089: extract idempotency key before any processing.
  const rawKey = request.headers.get("Idempotency-Key");
  const idempotencyKey = isValidIdempotencyKey(rawKey) ? rawKey : null;

  // ── JSON body path (BND-083: storage-path based submission) ─────────
  const reqContentType = request.headers.get("content-type") ?? "";
  if (
    reqContentType.includes("application/json") &&
    !reqContentType.includes("multipart")
  ) {
    const parsed = await parseJson(request, InvoicePathBodySchema, {
      message: "Invalid body.",
    });
    if (!parsed.ok) return parsed.response;
    const { imagePath } = parsed.data;

    const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
    const allowedExtensions = new Set([
      "jpg",
      "jpeg",
      "png",
      "heic",
      "heif",
      "pdf",
    ]);
    if (!allowedExtensions.has(ext)) {
      return Errors.unsupportedMediaType(
        "Unsupported file type: ." +
          (ext || "unknown") +
          ". Allowed: jpeg, png, heic, pdf.",
      );
    }
    if (!imagePath.startsWith(restaurantId + "/")) {
      return Errors.notFound("Image");
    }

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

    const result = await withIdempotency({
      supabase,
      restaurantId,
      key: idempotencyKey,
      handler: async () => {
        // Avoid storage, database, and OCR work entirely on idempotency replay.
        assertInvoiceExtractionConfigured();
        const { data: fileData, error: downloadError } = await supabase.storage
          .from("invoice-images")
          .download(imagePath);
        if (downloadError && !isStorageNotFound(downloadError)) {
          throw downloadError;
        }
        if (downloadError || !fileData) {
          return {
            status: 404,
            body: {
              error: { code: "not_found", message: "Image not found." },
            },
          };
        }

        const fileBuffer = Buffer.from(await fileData.arrayBuffer());
        if (fileBuffer.length > MAX_BYTES) {
          return {
            status: 413,
            body: {
              error: {
                code: "too_large",
                message: "File exceeds 10 MB.",
              },
            },
          };
        }

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
          throw insertError ?? new Error("invoice_scans insert returned no row");
        }

        return processInvoiceScanOnce({
          supabase,
          restaurantId,
          userId: user.id,
          fileBuffer,
          mimeType,
          preCreatedScanId: invoiceScan.id,
          preUploadedPath: imagePath,
        });
      },
    });

    return apiResultResponse(result);
  }

  // ── Form-data path ──────────────────────────────────────────────────
  const parsed = await parseMultipart(request, InvoiceFilesSchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const files = parsed.data.file;
  for (const pageFile of files) {
    if (pageFile.size === 0) return Errors.badRequest("Empty file.");
    if (pageFile.size > MAX_BYTES) {
      return Errors.tooLarge("File exceeds 10 MB.");
    }
    if (!ALLOWED_MIME.has(pageFile.type)) {
      return Errors.unsupportedMediaType(
        "Unsupported file type: " + (pageFile.type || "unknown") + ".",
      );
    }
  }
  const file = files[0];

  // Preflight Anthropic config before Azure processing.
  assertInvoiceExtractionConfigured();

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
    try {
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
            const pageExt = MIME_EXTENSIONS.get(pageFile.type) ?? "jpg";
            const pageTag = files.length !== 1 ? "_page" + pageIdx : "";
            const pagePath =
              restaurantId + "/" + scanId + pageTag + "." + pageExt;
            const pageBuf = Buffer.from(
              new Uint8Array(await pageFile.arrayBuffer()),
            );
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
          await supabase
            .from("invoice_scans")
            .update({ extra_image_paths: extraPaths })
            .eq("id", scanId);
        }
      }
    } catch {
      // Storage enrichment is best-effort after the scan has completed.
    }
  }

  return apiResultResponse(result);
}
