/**
 * GET  /api/import/batches — list this restaurant's import batches.
 * POST /api/import/batches — confirm an import: re-derive the preview
 * from the uploaded file server-side and persist it as a batch + rows.
 * Zero rows are written on any validation failure (mirrors preview's
 * zero-write guarantee up to the point where the file itself is judged
 * good enough to persist).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { rateLimit } from "@/lib/api/rate-limit";
import { apiError, Errors } from "@/lib/api/errors";
import { fileField, parseMultipart } from "@/lib/api/validation";
import { confirmImportBatch } from "@/domains/import/batch-service";
import { validateUploadedCsvFile } from "@/domains/import/upload-validation";

export const runtime = "nodejs";
export const maxDuration = 60;

const CONFIRM_RATE_LIMIT = 10;
const CONFIRM_RATE_WINDOW_MS = 60 * 1000;

const ConfirmSchema = z.object({ file: fileField });

export async function GET() {
  return withApiHandler(getBatches);
}

async function getBatches() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { data, error } = await supabase
    .from("import_batches")
    .select("id, filename, status, total_rows, created_at, reverted_at")
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return NextResponse.json({ batches: data ?? [] });
}

export async function POST(request: NextRequest) {
  return withApiHandler(() => postBatches(request));
}

async function postBatches(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, user } = auth;

  const limit = rateLimit(`import-confirm:${restaurantId}`, CONFIRM_RATE_LIMIT, CONFIRM_RATE_WINDOW_MS);
  if (!limit.ok) {
    return Errors.rateLimited("Too many import requests. Please wait before retrying.", {
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  const parsed = await parseMultipart(request, ConfirmSchema, { message: "Expected a CSV file upload." });
  if (!parsed.ok) return parsed.response;
  const { file } = parsed.data;

  const uploadCheck = validateUploadedCsvFile(file);
  if (!uploadCheck.ok) {
    return uploadCheck.code === "too_large"
      ? Errors.tooLarge(uploadCheck.message)
      : Errors.unsupportedMediaType(uploadCheck.message);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await confirmImportBatch(supabase, restaurantId, user.id, file.name, buffer);

  if (!result.ok) {
    const details = result.error.missingHeaders ? { missingHeaders: result.error.missingHeaders } : undefined;
    return apiError(422, result.error.code, result.error.message, details);
  }

  return NextResponse.json(
    { batchId: result.batchId, totalRows: result.totalRows, summary: result.summary },
    { status: 201 },
  );
}
