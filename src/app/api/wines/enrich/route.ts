import { NextResponse } from "next/server";
import {
  enqueueWineEnrichmentJob,
  WineEnrichmentJobConflictError,
} from "@/domains/wine-intelligence/wine-enrichment-job-service";
import { requireCapability } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { isValidIdempotencyKey } from "@/lib/api/idempotency";
import { isWineEnrichmentWorkerEnabled } from "@/lib/jobs/wine-enrichment-worker-rollout";
import { enrichRestaurantBatch } from "@/lib/wine-intelligence/batch";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage", {
      rateLimit: "expensive",
    });
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;
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
      operationId: "api:POST:/api/wines/enrich",
      payload: {},
      releaseOnError: false,
      handler: async () => {
        if (workerEnabled && idempotencyKey) {
          try {
            const job = await enqueueWineEnrichmentJob({
              supabase,
              restaurantId,
              idempotencyKey,
            });
            return {
              status: 202,
              body: { jobId: job.id, status: job.status },
              headers: { "Retry-After": "2" },
            };
          } catch (error) {
            if (error instanceof WineEnrichmentJobConflictError) {
              return {
                status: 409,
                body: {
                  error: {
                    code: "idempotency_conflict",
                    message:
                      "This Idempotency-Key was already used for different enrichment input.",
                  },
                },
              };
            }
            throw error;
          }
        }
        const result = await enrichRestaurantBatch({ supabase, restaurantId });
        if (result.error) {
          return {
            status: 500,
            body: {
              error: {
                code: "internal_error",
                message: "Internal server error.",
              },
            },
          };
        }
        return { status: 200, body: result };
      },
    });
  });
}
