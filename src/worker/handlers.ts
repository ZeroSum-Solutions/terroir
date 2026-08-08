import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.ts";
import { isWineEnrichmentHandlerEnabled } from "../lib/jobs/wine-enrichment-worker-rollout.ts";
import type { JobHandlers } from "./types.ts";
import { createWineEnrichmentJobHandler } from "./wine-enrichment-handler.ts";
import { createWineListPdfJobHandler } from "./wine-list-pdf-handler.ts";

/**
 * TER-021C owns the worker control plane. Business handlers are registered by
 * TER-021E/F/G before their corresponding enqueue paths are enabled.
 */
export function createJobHandlers(
  supabase: SupabaseClient<Database>,
  env: Record<string, string | undefined> = process.env,
): JobHandlers {
  const handlers: JobHandlers = {
    wine_list_pdf: createWineListPdfJobHandler(supabase),
  };
  if (isWineEnrichmentHandlerEnabled(env)) {
    handlers.wine_enrichment = createWineEnrichmentJobHandler(supabase);
  }
  return handlers;
}
