/**
 * POST /api/import/convert — turn an uploaded .xlsx workbook into the CSV
 * text the rest of the import pipeline already understands.
 *
 * Performs ZERO database writes and does not create a session or batch. The
 * client calls this the moment a spreadsheet is selected, then proceeds
 * through the ordinary CSV flow — client-side decode, record splitting, chunk
 * planning, preview, confirm — with the returned text. Keeping the conversion
 * here rather than in the browser keeps the (heavy, server-only) xlsx reader
 * out of the client bundle, while still handing the client the CSV it needs to
 * split a large sheet into chunks exactly as it splits a large .csv.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { rateLimit } from "@/lib/api/rate-limit";
import { apiError, Errors } from "@/lib/api/errors";
import { fileField, parseMultipart } from "@/lib/api/validation";
import { convertSpreadsheetToCsv } from "@/domains/import/spreadsheet-to-csv";
import { validateUploadedSpreadsheetFile } from "@/domains/import/upload-validation";

export const runtime = "nodejs";
export const maxDuration = 60;

// Converting is markedly more expensive than previewing (a whole workbook is
// parsed in memory), so it gets its own, tighter budget rather than sharing
// the preview route's.
const CONVERT_RATE_LIMIT = 10;
const CONVERT_RATE_WINDOW_MS = 60 * 1000;

const ConvertSchema = z.object({ file: fileField });

export async function POST(request: NextRequest) {
  return withApiHandler(() => postConvert(request));
}

async function postConvert(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { restaurantId } = auth;

  const limit = rateLimit(`import-convert:${restaurantId}`, CONVERT_RATE_LIMIT, CONVERT_RATE_WINDOW_MS);
  if (!limit.ok) {
    return Errors.rateLimited("Too many spreadsheet conversions. Please wait before retrying.", {
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  const parsed = await parseMultipart(request, ConvertSchema, {
    message: "Expected a spreadsheet file upload.",
  });
  if (!parsed.ok) return parsed.response;
  const { file } = parsed.data;

  const uploadCheck = validateUploadedSpreadsheetFile(file);
  if (!uploadCheck.ok) {
    return uploadCheck.code === "too_large"
      ? Errors.tooLarge(uploadCheck.message)
      : Errors.unsupportedMediaType(uploadCheck.message);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const converted = await convertSpreadsheetToCsv(buffer);

  if (!converted.ok) {
    // A sheet too big to convert is a size refusal (413); a sheet we cannot
    // make sense of at all is an unprocessable entity (422).
    return converted.code === "too_many_rows" || converted.code === "too_large_converted"
      ? Errors.tooLarge(converted.message)
      : apiError(422, converted.code, converted.message);
  }

  return NextResponse.json({
    csv: converted.csv,
    sheetName: converted.sheetName,
    rowCount: converted.rowCount,
    sheetCount: converted.sheetCount,
  });
}
