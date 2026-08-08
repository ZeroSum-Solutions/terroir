import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";

const QueuedJobSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "queued",
    "running",
    "retrying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
});

type Client = SupabaseClient<Database>;

export class WineEnrichmentJobConflictError extends Error {}
export class WineEnrichmentSubjectNotFoundError extends Error {}

export async function enqueueWineEnrichmentJob(input: {
  supabase: Client;
  restaurantId: string;
  idempotencyKey: string;
  wineId?: string;
}): Promise<{ id: string; status: string }> {
  if (input.wineId) {
    const { data: wine, error: wineError } = await input.supabase
      .from("wines")
      .select("id")
      .eq("id", input.wineId)
      .eq("restaurant_id", input.restaurantId)
      .maybeSingle();
    if (wineError) throw wineError;
    if (!wine) throw new WineEnrichmentSubjectNotFoundError();
  }

  const isSingleWine = input.wineId !== undefined;
  const { data, error } = await input.supabase.rpc("enqueue_background_job", {
    p_restaurant_id: input.restaurantId,
    p_job_type: "wine_enrichment",
    p_idempotency_key: input.idempotencyKey,
    p_subject_table: isSingleWine ? "wines" : "restaurants",
    p_subject_id: input.wineId ?? input.restaurantId,
    p_metadata: { scope: isSingleWine ? "wine" : "restaurant" },
    p_max_attempts: 3,
  });
  if (error) {
    if (
      error.code === "22023" &&
      error.message.includes(
        "idempotency key was reused with different job input",
      )
    ) {
      throw new WineEnrichmentJobConflictError();
    }
    throw error;
  }
  return QueuedJobSchema.parse(data);
}
