import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listSupabaseObjectPaths,
  removeSupabaseObjects,
  SupabaseStorageError,
} from "@/adapters/storage";
import type { Database } from "@/types/database";

const STORAGE_BUCKETS = [
  "invoice-images",
  "wine-images",
  "generated-exports",
] as const;

export class PrivacyStorageCleanupError extends Error {
  constructor(cause: unknown) {
    super("Failed to remove tenant storage objects.");
    this.name = "PrivacyStorageCleanupError";
    this.cause = cause;
  }
}

export async function removeTenantStorageObjects(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
}): Promise<void> {
  const { supabase, restaurantId } = input;

  try {
    for (const bucket of STORAGE_BUCKETS) {
      const paths = await listSupabaseObjectPaths({
        supabase,
        bucket,
        prefix: restaurantId,
      });
      if (paths.length === 0) continue;
      await removeSupabaseObjects({ supabase, bucket, paths });
    }
  } catch (error) {
    if (error instanceof SupabaseStorageError) {
      throw new PrivacyStorageCleanupError(error);
    }
    throw error;
  }
}

export async function removeWineImageObjects(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
}): Promise<void> {
  const { supabase, restaurantId, wineId } = input;
  const paths = ["jpg", "png", "webp"].map(
    (extension) => `${restaurantId}/${wineId}.${extension}`,
  );

  try {
    await removeSupabaseObjects({
      supabase,
      bucket: "wine-images",
      paths,
    });
  } catch (error) {
    if (error instanceof SupabaseStorageError) {
      throw new PrivacyStorageCleanupError(error);
    }
    throw error;
  }
}
