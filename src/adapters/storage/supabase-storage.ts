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

export async function createSupabaseSignedUrls(
  input: Omit<StorageInput, "path"> & {
    paths: string[];
    expiresInSeconds: number;
  },
): Promise<Map<string, string>> {
  const { supabase, bucket, paths, expiresInSeconds } = input;
  const signedUrls = new Map<string, string>();

  // Limit each signing request so large cellars do not create one request per
  // image or exceed the provider's bulk-operation ceiling.
  for (let offset = 0; offset < paths.length; offset += 100) {
    const { data, error } = await supabase
      .storage
      .from(bucket)
      .createSignedUrls(paths.slice(offset, offset + 100), expiresInSeconds);

    if (error) {
      throw new SupabaseStorageError("Failed to create signed URLs.", {
        cause: error,
      });
    }
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) {
        signedUrls.set(entry.path, entry.signedUrl);
      }
    }
  }

  return signedUrls;
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

export async function removeSupabaseObjects(
  input: Omit<StorageInput, "path"> & { paths: string[] },
): Promise<void> {
  const { supabase, bucket, paths } = input;
  // Keep deletes below the provider's bulk-operation ceiling. This makes
  // tenant cleanup safe even when a prefix has more than one list page.
  for (let offset = 0; offset < paths.length; offset += 100) {
    const { error } = await supabase
      .storage
      .from(bucket)
      .remove(paths.slice(offset, offset + 100));

    if (error) {
      throw new SupabaseStorageError("Failed to remove objects.", {
        cause: error,
      });
    }
  }
}

export async function listSupabaseObjectPaths(
  input: Omit<StorageInput, "path"> & { prefix: string },
): Promise<string[]> {
  const { supabase, bucket, prefix } = input;
  const paths: string[] = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      throw new SupabaseStorageError("Failed to list objects.", {
        cause: error,
      });
    }

    const page = data ?? [];
    for (const object of page) {
      if (object.name) paths.push(`${prefix}/${object.name}`);
    }
    if (page.length < pageSize) return paths;
    offset += pageSize;
  }
}
