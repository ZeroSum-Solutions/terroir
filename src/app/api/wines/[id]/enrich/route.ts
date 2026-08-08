import { NextResponse } from "next/server";
import {
  enqueueWineEnrichmentJob,
  WineEnrichmentJobConflictError,
  WineEnrichmentSubjectNotFoundError,
} from "@/domains/wine-intelligence/wine-enrichment-job-service";
import { requireCapability } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { isValidIdempotencyKey } from "@/lib/api/idempotency";
import { isWineEnrichmentWorkerEnabled } from "@/lib/jobs/wine-enrichment-worker-rollout";
import { parseParams } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";
import { enrichSingleWine } from "@/lib/wine-intelligence/single";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage", {
      rateLimit: "expensive",
    });
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;
    const workerEnabled = isWineEnrichmentWorkerEnabled();
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (workerEnabled && !isValidIdempotencyKey(idempotencyKey)) {
      return Errors.badRequest(
        "A valid Idempotency-Key is required for queued wine enrichment.",
        undefined,
        "invalid_idempotency_key",
      );
    }

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/wines/{param}/enrich",
      payload: { id },
      releaseOnError: false,
      handler: async () => {
        if (workerEnabled && idempotencyKey) {
          try {
            const job = await enqueueWineEnrichmentJob({
              supabase,
              restaurantId,
              wineId: id,
              idempotencyKey,
            });
            return {
              status: 202,
              body: { jobId: job.id, status: job.status },
              headers: { "Retry-After": "2" },
            };
          } catch (error) {
            if (error instanceof WineEnrichmentSubjectNotFoundError) {
              return errorResult("not_found", "Wine not found.", 404);
            }
            if (error instanceof WineEnrichmentJobConflictError) {
              return errorResult(
                "idempotency_conflict",
                "This Idempotency-Key was already used for different enrichment input.",
                409,
              );
            }
            throw error;
          }
        }
        return enrichSingleWine({
          supabase,
          restaurantId,
          wineId: id,
        });
      },
    });
  });
}

function errorResult(code: string, message: string, status: number) {
  return { status, body: { error: { code, message } } };
}
