import type { SupabaseClient } from "@supabase/supabase-js";
import { processInvoiceScanOnce } from "@/domains/scanning/invoice-scan-service";
import { INVOICE_IMAGE_BUCKET, SYSTEM_USER_PLACEHOLDER } from "@/lib/jobs/constants";
import type { ClaimedInvoiceExtractJob, JobOutcome } from "@/lib/jobs/types";
import type { Database } from "@/types/database";

const EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

/** Error codes worth retrying: transient/upstream, not a data problem. */
const RETRYABLE_CODES = new Set(["upstream_error", "rate_limited"]);

export async function runInvoiceExtractJob(params: {
  supabase: SupabaseClient<Database>;
  job: ClaimedInvoiceExtractJob;
}): Promise<JobOutcome> {
  const { supabase, job } = params;

  if (!job.subjectId) {
    return { kind: "dead", code: "missing_subject", message: "Job has no subject_id." };
  }

  // ── Tenant-scoping enforcement point ──────────────────────────────
  // The service role bypasses RLS entirely, so this WHERE clause — not
  // any policy — is what stops a job whose restaurant_id doesn't
  // actually own subjectId from touching another tenant's scan. See
  // src/lib/jobs/tenant-isolation.test.ts for the fixture proof.
  const { data: scan, error: fetchError } = await supabase
    .from("invoice_scans")
    .select("id, status, raw_image_path, created_by")
    .eq("id", job.subjectId)
    .eq("restaurant_id", job.restaurantId)
    .maybeSingle();

  if (fetchError) {
    return { kind: "retry", code: "subject_fetch_failed", message: fetchError.message };
  }
  if (!scan) {
    // Either the scan doesn't exist, or it belongs to a different
    // restaurant than the job claims. Both are terminal: retrying
    // can't fix a tenant mismatch or a missing row.
    return {
      kind: "dead",
      code: "tenant_mismatch_or_missing_subject",
      message:
        `No invoice_scans row ${job.subjectId} found for restaurant ${job.restaurantId}.`,
    };
  }

  // ── No-double-bill guarantee ───────────────────────────────────────
  // A retried job (e.g. requeued by the stuck-job reclaim sweep after a
  // worker crash) whose extraction already persisted must not re-call
  // Anthropic. invoice_scans.status === "complete" is the existing,
  // already-persisted signal that the OCR+LLM pipeline already ran and
  // wrote a result for this scan — checked here, before any provider call.
  if (scan.status === "complete") {
    return { kind: "succeeded", skippedExtraction: true };
  }

  if (!scan.raw_image_path || !scan.raw_image_path.startsWith(`${job.restaurantId}/`)) {
    return {
      kind: "dead",
      code: "missing_or_mistenanted_image_path",
      message: "raw_image_path is missing or not scoped to the job's restaurant.",
    };
  }

  const extension = scan.raw_image_path.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = EXTENSION_MIME[extension];
  if (!mimeType) {
    return {
      kind: "dead",
      code: "unsupported_extension",
      message: `Unsupported file extension: .${extension || "unknown"}.`,
    };
  }

  const { data: fileData, error: downloadError } = await supabase.storage
    .from(INVOICE_IMAGE_BUCKET)
    .download(scan.raw_image_path);
  if (downloadError || !fileData) {
    return {
      kind: "retry",
      code: "image_download_failed",
      message: downloadError?.message ?? "Storage download returned no data.",
    };
  }

  const fileBuffer = Buffer.from(await fileData.arrayBuffer());

  let result;
  try {
    result = await processInvoiceScanOnce({
      supabase,
      restaurantId: job.restaurantId,
      // Inert on this path: processInvoiceScanOnce only reads userId when
      // creating a fresh invoice_scans row, which preCreatedScanId skips.
      userId: job.createdBy ?? scan.created_by ?? SYSTEM_USER_PLACEHOLDER,
      fileBuffer,
      mimeType,
      preCreatedScanId: scan.id,
      preUploadedPath: scan.raw_image_path,
    });
  } catch (error) {
    return {
      kind: "retry",
      code: "extraction_threw",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return classifyResult(result);
}

function classifyResult(result: { status: number; body: unknown }): JobOutcome {
  if (result.status === 200) {
    return { kind: "succeeded", skippedExtraction: false };
  }

  const body = result.body as { code?: string; message?: string } | undefined;
  const code = body?.code ?? `http_${result.status}`;
  const message = body?.message ?? `Extraction returned status ${result.status}.`;

  if (RETRYABLE_CODES.has(code) || result.status >= 500) {
    return { kind: "retry", code, message };
  }
  return { kind: "dead", code, message };
}
