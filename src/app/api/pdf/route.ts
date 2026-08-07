import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  generateWineListPdf,
  WineListPdfGenerationError,
  WineListPdfNotFoundError,
} from "@/domains/wine-lists/wine-list-pdf-service";
import {
  enqueueWineListPdfJob,
  loadWineListPdfArtifact,
  WineListPdfArtifactError,
  WineListPdfJobCancelledError,
  WineListPdfJobConflictError,
  WineListPdfJobFailedError,
  WineListPdfJobNotFoundError,
} from "@/domains/wine-lists/wine-list-pdf-job-service";
import { requireMembership } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { isValidIdempotencyKey } from "@/lib/api/idempotency";
import { parseJson } from "@/lib/api/validation";
import { isPdfWorkerEnabled } from "@/lib/jobs/pdf-worker-rollout";

export const runtime = "nodejs";
export const maxDuration = 30;

const BodySchema = z
  .object({
    listId: z.string().uuid().optional(),
    jobId: z.string().uuid().optional(),
    template: z.enum(["classic", "modern", "minimal"]).optional(),
  })
  .superRefine((value, context) => {
    if ((value.listId ? 1 : 0) + (value.jobId ? 1 : 0) !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of listId or jobId.",
        path: [],
      });
    }
    if (value.jobId && value.template) {
      context.addIssue({
        code: "custom",
        message: "template is valid only for a new PDF request.",
        path: ["template"],
      });
    }
  });

export async function POST(request: NextRequest) {
  return withApiHandler(() => postPdf(request));
}

async function postPdf(request: NextRequest) {
  // Gate on membership and scope every query by restaurant_id. RLS should
  // already enforce this, but belt-and-suspenders: a wine list belonging to a
  // restaurant the caller is not a member of must return 404, not 403 — a 403
  // would confirm the list exists. (ARCH-002)
  const auth = await requireMembership({ rateLimit: "expensive" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  try {
    if (body.jobId) {
      const artifact = await loadWineListPdfArtifact({
        supabase,
        restaurantId,
        jobId: body.jobId,
      });
      if (artifact.kind === "pending") {
        return NextResponse.json(
          { jobId: body.jobId, status: artifact.status },
          { status: 202, headers: { "Retry-After": "2" } },
        );
      }
      return new NextResponse(artifact.pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${artifact.filename}"`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    if (!body.listId) {
      return Errors.badRequest("Invalid body.");
    }

    if (isPdfWorkerEnabled()) {
      const idempotencyKey = request.headers.get("Idempotency-Key");
      if (!isValidIdempotencyKey(idempotencyKey)) {
        return Errors.badRequest(
          "A valid Idempotency-Key is required for queued PDF generation.",
          undefined,
          "invalid_idempotency_key",
        );
      }
      const job = await enqueueWineListPdfJob({
        supabase,
        restaurantId,
        listId: body.listId,
        idempotencyKey,
        template: body.template,
      });
      return NextResponse.json(
        { jobId: job.id, status: job.status },
        { status: 202, headers: { "Retry-After": "2" } },
      );
    }

    const result = await generateWineListPdf({
      supabase,
      restaurantId,
      listId: body.listId,
      template: body.template,
    });

    const pdfBody = new Uint8Array(result.pdf).buffer;
    return new NextResponse(pdfBody, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${result.filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof WineListPdfNotFoundError) {
      return Errors.notFound("Wine list");
    }
    if (error instanceof WineListPdfJobNotFoundError) {
      return Errors.notFound("PDF job");
    }
    if (error instanceof WineListPdfJobConflictError) {
      return Errors.conflict(
        "idempotency_conflict",
        "This Idempotency-Key was already used for different PDF input.",
      );
    }
    if (error instanceof WineListPdfJobCancelledError) {
      return Errors.conflict("pdf_job_cancelled", "PDF generation was cancelled.");
    }
    if (error instanceof WineListPdfJobFailedError) {
      return apiError(422, "pdf_job_failed", "PDF generation failed.");
    }
    if (error instanceof WineListPdfArtifactError) {
      return apiError(500, "pdf_artifact_unavailable", "PDF artifact is unavailable.");
    }
    if (error instanceof WineListPdfGenerationError) {
      return apiError(500, "pdf_generation_failed", "PDF generation failed.");
    }
    throw error;
  }
}
