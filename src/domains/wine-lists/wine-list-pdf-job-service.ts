import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { wineListPdfArtifactPath } from "./wine-list-pdf-service";
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

const ArtifactResultSchema = z
  .object({
    artifact_path: z.string().min(1).max(512),
    filename: z.string().min(5).max(204).regex(/^[A-Za-z0-9 ]+\.pdf$/),
    list_id: z.string().uuid(),
    template: z.enum(["classic", "modern", "minimal"]),
  })
  .strict();

type Client = SupabaseClient<Database>;

export class WineListPdfJobNotFoundError extends Error {}
export class WineListPdfJobConflictError extends Error {}
export class WineListPdfJobFailedError extends Error {}
export class WineListPdfJobCancelledError extends Error {}
export class WineListPdfArtifactError extends Error {}

export async function enqueueWineListPdfJob(input: {
  supabase: Client;
  restaurantId: string;
  listId: string;
  idempotencyKey: string;
  template?: "classic" | "modern" | "minimal";
}): Promise<{ id: string; status: string }> {
  const { data: list, error: listError } = await input.supabase
    .from("wine_lists")
    .select("id")
    .eq("id", input.listId)
    .eq("restaurant_id", input.restaurantId)
    .maybeSingle();
  if (listError) throw listError;
  if (!list) throw new WineListPdfJobNotFoundError();

  const { data, error } = await input.supabase.rpc("enqueue_background_job", {
    p_restaurant_id: input.restaurantId,
    p_job_type: "wine_list_pdf",
    p_idempotency_key: input.idempotencyKey,
    p_subject_table: "wine_lists",
    p_subject_id: input.listId,
    p_metadata: input.template ? { template: input.template } : {},
    p_max_attempts: 3,
  });
  if (error) {
    if (error.code === "22023") throw new WineListPdfJobConflictError();
    throw error;
  }
  return QueuedJobSchema.parse(data);
}

export type WineListPdfArtifactState =
  | { kind: "pending"; status: "queued" | "running" | "retrying" }
  | { kind: "ready"; filename: string; pdf: ArrayBuffer };

export async function loadWineListPdfArtifact(input: {
  supabase: Client;
  restaurantId: string;
  jobId: string;
}): Promise<WineListPdfArtifactState> {
  const { data: job, error } = await input.supabase
    .from("background_jobs")
    .select("id, job_type, restaurant_id, subject_id, subject_table, status, result")
    .eq("id", input.jobId)
    .eq("restaurant_id", input.restaurantId)
    .maybeSingle();
  if (error) throw error;
  if (
    !job ||
    job.job_type !== "wine_list_pdf" ||
    job.subject_table !== "wine_lists" ||
    !job.subject_id
  ) {
    throw new WineListPdfJobNotFoundError();
  }
  if (
    job.status === "queued" ||
    job.status === "running" ||
    job.status === "retrying"
  ) {
    return { kind: "pending", status: job.status };
  }
  if (job.status === "cancelled") throw new WineListPdfJobCancelledError();
  if (job.status !== "succeeded") throw new WineListPdfJobFailedError();

  const parsed = ArtifactResultSchema.safeParse(job.result);
  if (!parsed.success || parsed.data.list_id !== job.subject_id) {
    throw new WineListPdfArtifactError();
  }
  const expectedPath = wineListPdfArtifactPath({
    restaurantId: input.restaurantId,
    listId: job.subject_id,
    template: parsed.data.template,
  });
  if (parsed.data.artifact_path !== expectedPath) {
    throw new WineListPdfArtifactError();
  }

  const { data: artifact, error: artifactError } = await input.supabase.storage
    .from("generated-exports")
    .download(expectedPath);
  if (artifactError || !artifact) throw new WineListPdfArtifactError();
  return {
    kind: "ready",
    filename: parsed.data.filename,
    pdf: await artifact.arrayBuffer(),
  };
}
