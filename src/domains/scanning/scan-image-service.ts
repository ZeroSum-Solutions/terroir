import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSupabaseSignedUrl,
  SupabaseStorageError,
} from "@/adapters/storage";
import type { Database } from "@/types/database";

const INVOICE_IMAGE_BUCKET = "invoice-images";
const SIGNED_URL_TTL_SECONDS = 300;

export class ScanImageNotFoundError extends Error {
  constructor() {
    super("Scan image not found.");
    this.name = "ScanImageNotFoundError";
  }
}

export class ScanImageStorageError extends Error {
  constructor(cause: unknown) {
    super("Failed to generate scan image URL.");
    this.name = "ScanImageStorageError";
    this.cause = cause;
  }
}

export type GetScanImageUrlInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  scanId: string;
};

export async function getScanImageUrl(
  input: GetScanImageUrlInput,
): Promise<string> {
  const { supabase, restaurantId, scanId } = input;

  const { data: scan, error: fetchError } = await supabase
    .from("invoice_scans")
    .select("raw_image_path")
    .eq("id", scanId)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError && (fetchError as { code?: string }).code !== "PGRST116") {
    throw fetchError;
  }
  if (
    !scan?.raw_image_path ||
    !scan.raw_image_path.startsWith(`${restaurantId}/`)
  ) {
    throw new ScanImageNotFoundError();
  }

  try {
    return await createSupabaseSignedUrl({
      supabase,
      bucket: INVOICE_IMAGE_BUCKET,
      path: scan.raw_image_path,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch (error) {
    if (error instanceof SupabaseStorageError) {
      console.error("fetch-storage failed.");
      Sentry.captureException(error.cause ?? error, {
        tags: { surface: "scanner", phase: "fetch-storage" },
        extra: { scan_id: scanId },
      });
      throw new ScanImageStorageError(error);
    }
    throw error;
  }
}
