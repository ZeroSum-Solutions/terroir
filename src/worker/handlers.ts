import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.ts";
import type { JobHandlers } from "./types.ts";
import { createWineListPdfJobHandler } from "./wine-list-pdf-handler.ts";

/**
 * TER-021C owns the worker control plane. Business handlers are registered by
 * TER-021E/F/G before their corresponding enqueue paths are enabled.
 */
export function createJobHandlers(
  supabase: SupabaseClient<Database>,
): JobHandlers {
  return {
    wine_list_pdf: createWineListPdfJobHandler(supabase),
  };
}
