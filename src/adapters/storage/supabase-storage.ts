import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export class SupabaseStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SupabaseStorageError";
    this.cause = options?.cause;
  }
}

type StorageInput = {
  supabase: SupabaseClient<Database>;
  bucket: string;
  path: string;
};

export async function createSupabaseSignedUrl(
  input: StorageInput & { expiresInSeconds: number },
): Promise<string> {
  const { supabase, bucket, path, expiresInSeconds } = input;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new SupabaseStorageError("Failed to create signed URL.", {
      cause: error ?? new Error("No signed URL returned"),
    });
  }

  return data.signedUrl;
}

export async function uploadSupabaseObject(
  input: StorageInput & {
    body: Buffer | ArrayBuffer | Blob;
    contentType: string;
    upsert?: boolean;
  },
): Promise<void> {
  const { supabase, bucket, path, body, contentType, upsert = false } = input;
  const { error } = await supabase.storage.from(bucket).upload(path, body, {
    contentType,
    upsert,
  });

  if (error) {
    throw new SupabaseStorageError("Failed to upload object.", {
      cause: error,
    });
  }
}

export function getSupabasePublicUrl(input: StorageInput): string {
  const { supabase, bucket, path } = input;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl ?? "";
}

export async function removeSupabaseObjects(
  input: Omit<StorageInput, "path"> & { paths: string[] },
): Promise<void> {
  const { supabase, bucket, paths } = input;
  const { error } = await supabase.storage.from(bucket).remove(paths);

  if (error) {
    throw new SupabaseStorageError("Failed to remove objects.", {
      cause: error,
    });
  }
}
