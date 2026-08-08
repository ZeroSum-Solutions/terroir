import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { enrichSingleWine } from "../lib/wine-intelligence/single.ts";
import { enrichRestaurantBatch } from "../lib/wine-intelligence/batch.ts";
import { WineEnrichmentProviderError } from "../lib/wine-intelligence/enrich-claude.ts";
import type { Database } from "../types/database.ts";
import { JobExecutionError, LeaseLostError } from "./errors.ts";
import type { BackgroundJob, JobHandler } from "./types.ts";

const MetadataSchema = z
  .object({ scope: z.enum(["restaurant", "wine"]) })
  .strict();

export type WineEnrichmentHandlerDependencies = {
  enrichRestaurant: typeof enrichRestaurantBatch;
  enrichSingle: typeof enrichSingleWine;
};

const DEFAULT_DEPENDENCIES: WineEnrichmentHandlerDependencies = {
  enrichRestaurant: enrichRestaurantBatch,
  enrichSingle: enrichSingleWine,
};

function invalidPayload(): JobExecutionError {
  return new JobExecutionError(
    "invalid_wine_enrichment_job_payload",
    false,
    "Wine-enrichment job payload is invalid",
  );
}

function parseJob(job: Readonly<BackgroundJob>) {
  const restaurantId = z.string().uuid().safeParse(job.restaurant_id);
  const subjectId = z.string().uuid().safeParse(job.subject_id);
  const metadata = MetadataSchema.safeParse(job.metadata);
  if (
    job.job_type !== "wine_enrichment" ||
    !restaurantId.success ||
    !subjectId.success ||
    !metadata.success
  ) {
    throw invalidPayload();
  }
  if (
    metadata.data.scope === "restaurant" &&
    (job.subject_table !== "restaurants" ||
      subjectId.data !== restaurantId.data)
  ) {
    throw invalidPayload();
  }
  if (
    metadata.data.scope === "wine" &&
    job.subject_table !== "wines"
  ) {
    throw invalidPayload();
  }
  return {
    restaurantId: restaurantId.data,
    scope: metadata.data.scope,
    subjectId: subjectId.data,
  };
}

function normalizedAbortReason(signal: AbortSignal): Error {
  if (
    signal.reason instanceof JobExecutionError ||
    signal.reason instanceof LeaseLostError
  ) {
    return signal.reason;
  }
  return new JobExecutionError(
    "job_aborted",
    true,
    "Wine enrichment was interrupted",
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw normalizedAbortReason(signal);
}

export function createWineEnrichmentJobHandler(
  supabase: SupabaseClient<Database>,
  dependencies: WineEnrichmentHandlerDependencies = DEFAULT_DEPENDENCIES,
): JobHandler {
  return async (job, signal) => {
    const parsed = parseJob(job);
    throwIfAborted(signal);
    try {
      if (parsed.scope === "restaurant") {
        const result = await dependencies.enrichRestaurant({
          supabase,
          restaurantId: parsed.restaurantId,
          signal,
          strictWorkerExecution: true,
        });
        throwIfAborted(signal);
        if ("error" in result) {
          throw new JobExecutionError(
            "wine_enrichment_failed",
            true,
            "Wine enrichment could not finish",
          );
        }
        return {
          scope: "restaurant",
          total: result.total,
          enriched: result.enriched,
          rule_enriched: result.ruleEnrichedCount,
          provider_enriched: result.claudeEnrichedCount,
          lwin_matched: result.lwinMatched,
          has_more: result.hasMore,
        };
      }

      const result = await dependencies.enrichSingle({
        supabase,
        restaurantId: parsed.restaurantId,
        wineId: parsed.subjectId,
        signal,
        throwOnProviderFailure: true,
      });
      throwIfAborted(signal);
      if (result.status === 404) {
        throw new JobExecutionError(
          "wine_enrichment_subject_not_found",
          false,
          "Wine no longer exists",
        );
      }
      if (result.status !== 200) {
        throw new JobExecutionError(
          "wine_enrichment_failed",
          result.status >= 500,
          "Wine enrichment could not finish",
        );
      }
      return {
        scope: "wine",
        wine_id: parsed.subjectId,
        source:
          typeof result.body.source === "string" ||
            result.body.source === null
            ? result.body.source
            : null,
      };
    } catch (error) {
      if (signal.aborted) throw normalizedAbortReason(signal);
      if (error instanceof JobExecutionError) throw error;
      if (error instanceof WineEnrichmentProviderError) {
        throw new JobExecutionError(
          error.code,
          error.retryable,
          "Wine enrichment provider failed",
        );
      }
      throw new JobExecutionError(
        "wine_enrichment_failed",
        true,
        "Wine enrichment could not finish",
      );
    }
  };
}
