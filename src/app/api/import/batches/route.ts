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
import { ConfirmBatchSessionFieldsSchema, RowOverridesFieldSchema } from "@/domains/import/request-schemas";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const runtime = "nodejs";
export const maxDuration = 60;

const CONFIRM_RATE_LIMIT = 10;
const CONFIRM_RATE_WINDOW_MS = 60 * 1000;

// P3 §3.2: optional session/chunk fields alongside the file, for a
// multi-chunk onboarding upload. All optional — a plain, non-chunked
// single-file upload omits every one of these and behaves exactly as
// before.
const ConfirmSchema = z
  .object({ file: fileField, rowOverrides: RowOverridesFieldSchema })
  .merge(ConfirmBatchSessionFieldsSchema);

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
  const { file, sessionId, chunkIndex, chunkTotal, sourceSha256, rowOverrides } = parsed.data;

  const uploadCheck = validateUploadedCsvFile(file);
  if (!uploadCheck.ok) {
    return uploadCheck.code === "too_large"
      ? Errors.tooLarge(uploadCheck.message)
      : Errors.unsupportedMediaType(uploadCheck.message);
  }

  // Same pattern as the /revert route's own createServiceRoleClient() call:
  // a null client (misconfigured environment) is passed straight through to
  // confirmImportBatch, which threads it to revertImportBatch on the
  // self-revert path a create-time race can trigger (selfRevertAndRetry) —
  // never a reason to fail the confirm itself.
  const serviceClient = createServiceRoleClient();
  if (!serviceClient) {
    console.error("confirm route: service-role client unavailable; self-revert orphan-wine cleanup will be skipped for this confirm");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await confirmImportBatch(supabase, restaurantId, user.id, file.name, buffer, {
    sessionId,
    chunkIndex,
    chunkTotal,
    sourceSha256,
    rowOverrides,
    serviceClient,
  });

  if (!result.ok) {
    // Round-27 audit (removes the in-preview conflict-recovery panel, which
    // failed five straight audits — see docs/runbooks/csv-import.md): this
    // used to also carry conflictingBatches/conflictingBatchesCount/
    // conflictingBatchesTruncated so the client could render a revert
    // affordance per candidate. That panel is gone; batch-service.ts's own
    // `message` (the only field left on a multiple_live_batches error
    // besides `code`) is the sole guidance the client shows for a conflict.
    const details = result.error.missingHeaders ? { missingHeaders: result.error.missingHeaders } : undefined;
    return apiError(422, result.error.code, result.error.message, details);
  }

  // P3 §2.2 (C09): identical content (or the same session+chunk_index)
  // was already confirmed — a resume pointer, not a fresh 201. The client
  // should offer "already uploaded as batch {batchId} ({status}) — call
  // /apply on it" rather than treating this as an error.
  if (result.alreadyExists) {
    return NextResponse.json(
      {
        batchId: result.batchId,
        alreadyExists: true,
        status: result.status,
        sessionId: result.sessionId,
        // Sol round-3 audit finding 3: carried alongside sessionId so the
        // chunked-upload client can require BOTH to match the exact slot
        // it's confirming before treating this as "this chunk is done."
        chunkIndex: result.chunkIndex,
        counts: result.counts,
      },
      { status: 200 },
    );
  }

  return NextResponse.json(
    { batchId: result.batchId, alreadyExists: false, totalRows: result.totalRows, summary: result.summary },
    { status: 201 },
  );
}
