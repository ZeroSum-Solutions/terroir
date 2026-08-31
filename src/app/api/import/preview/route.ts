/**
 * POST /api/import/preview — dry-run CSV cellar import preview.
 *
 * Parses, validates, and LWIN-matches every row and returns the full
 * per-row result. Performs ZERO database writes — buildImportPreview
 * only ever calls the read-only match_lwin_bulk RPC (see
 * src/domains/import/preview-service.ts). This is the bar-1 acceptance
 * requirement: an operator can see exactly what an import will do
 * before anything is persisted.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { rateLimit } from "@/lib/api/rate-limit";
import { apiError, Errors } from "@/lib/api/errors";
import { fileField, parseMultipart } from "@/lib/api/validation";
import { buildImportPreview } from "@/domains/import/preview-service";
import { validateUploadedCsvFile } from "@/domains/import/upload-validation";

export const runtime = "nodejs";
export const maxDuration = 60;

const PREVIEW_RATE_LIMIT = 20;
const PREVIEW_RATE_WINDOW_MS = 60 * 1000;

const PreviewSchema = z.object({ file: fileField });

export async function POST(request: NextRequest) {
  return withApiHandler(() => postPreview(request));
}

async function postPreview(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const limit = rateLimit(`import-preview:${restaurantId}`, PREVIEW_RATE_LIMIT, PREVIEW_RATE_WINDOW_MS);
  if (!limit.ok) {
    return Errors.rateLimited("Too many preview requests. Please wait before retrying.", {
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  const parsed = await parseMultipart(request, PreviewSchema, { message: "Expected a CSV file upload." });
  if (!parsed.ok) return parsed.response;
  const { file } = parsed.data;

  const uploadCheck = validateUploadedCsvFile(file);
  if (!uploadCheck.ok) {
    return uploadCheck.code === "too_large"
      ? Errors.tooLarge(uploadCheck.message)
      : Errors.unsupportedMediaType(uploadCheck.message);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const preview = await buildImportPreview(supabase, buffer);

  if (!preview.ok) {
    const details = preview.error.missingHeaders ? { missingHeaders: preview.error.missingHeaders } : undefined;
    return apiError(422, preview.error.code, preview.error.message, details);
  }

  // SCAN-03: `detectedSource` is derived server-side from the header row
  // alone, so it is the same on every chunk and identical on confirm — the
  // client is told which mapping profile was used, it never chooses one.
  return NextResponse.json({
    rows: preview.rows,
    summary: preview.summary,
    detectedSource: preview.detectedSource,
  });
}
