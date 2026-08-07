import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  generateWineListPdf,
  WineListPdfGenerationError,
  WineListPdfNotFoundError,
  wineListPdfArtifactPath,
} from "../domains/wine-lists/wine-list-pdf-service.ts";
import {
  SupabaseStorageError,
  uploadSupabaseObject,
} from "../adapters/storage/supabase-storage.ts";
import type { Database } from "../types/database.ts";
import { JobExecutionError } from "./errors.ts";
import type { BackgroundJob, JobHandler } from "./types.ts";

const MetadataSchema = z
  .object({
    template: z.enum(["classic", "modern", "minimal"]).optional(),
  })
  .strict();

export type WineListPdfHandlerDependencies = {
  generate: typeof generateWineListPdf;
  upload: typeof uploadSupabaseObject;
};

const DEFAULT_DEPENDENCIES: WineListPdfHandlerDependencies = {
  generate: generateWineListPdf,
  upload: uploadSupabaseObject,
};

function invalidPayload(): JobExecutionError {
  return new JobExecutionError(
    "invalid_pdf_job_payload",
    false,
    "Wine-list PDF job payload is invalid",
  );
}

function parseJob(job: Readonly<BackgroundJob>) {
  const restaurantId = z.string().uuid().safeParse(job.restaurant_id);
  const listId = z.string().uuid().safeParse(job.subject_id);
  const metadata = MetadataSchema.safeParse(job.metadata);
  if (
    job.job_type !== "wine_list_pdf" ||
    job.subject_table !== "wine_lists" ||
    !restaurantId.success ||
    !listId.success ||
    !metadata.success
  ) {
    throw invalidPayload();
  }
  return {
    restaurantId: restaurantId.data,
    listId: listId.data,
    metadata: metadata.data,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new JobExecutionError(
      "job_aborted",
      true,
      "Wine-list PDF job was interrupted",
    );
  }
}

export function createWineListPdfJobHandler(
  supabase: SupabaseClient<Database>,
  dependencies: WineListPdfHandlerDependencies = DEFAULT_DEPENDENCIES,
): JobHandler {
  return async (job, signal) => {
    const parsed = parseJob(job);
    throwIfAborted(signal);
    try {
      const generated = await dependencies.generate({
        supabase,
        restaurantId: parsed.restaurantId,
        listId: parsed.listId,
        template: parsed.metadata.template,
        signal,
      });
      throwIfAborted(signal);
      const artifactPath = wineListPdfArtifactPath({
        restaurantId: parsed.restaurantId,
        listId: parsed.listId,
        template: generated.template,
      });
      await dependencies.upload({
        supabase,
        bucket: "generated-exports",
        path: artifactPath,
        body: generated.pdf,
        contentType: "application/pdf",
        upsert: true,
      });
      throwIfAborted(signal);
      return {
        artifact_path: artifactPath,
        filename: generated.filename,
        list_id: parsed.listId,
        template: generated.template,
      };
    } catch (error) {
      if (error instanceof JobExecutionError) throw error;
      if (error instanceof WineListPdfNotFoundError) {
        throw new JobExecutionError(
          "pdf_source_not_found",
          false,
          "Wine list no longer exists",
        );
      }
      if (error instanceof SupabaseStorageError) {
        throw new JobExecutionError(
          "pdf_artifact_upload_failed",
          true,
          "Wine-list PDF artifact could not be stored",
        );
      }
      if (error instanceof WineListPdfGenerationError) {
        throw new JobExecutionError(
          "pdf_generation_failed",
          true,
          "Wine-list PDF generation failed",
        );
      }
      throw new JobExecutionError(
        "pdf_generation_failed",
        true,
        "Wine-list PDF generation failed",
      );
    }
  };
}
