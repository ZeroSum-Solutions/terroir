import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getSupabasePublicUrl,
  removeSupabaseObjects,
  SupabaseStorageError,
  uploadSupabaseObject,
} from "@/adapters/storage";
import type { Database } from "@/types/database";

const WINE_IMAGE_BUCKET = "wine-images";
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const WINE_IMAGE_EXTENSIONS = ["jpg", "png", "webp"] as const;

export class WineImageNotFoundError extends Error {
  constructor() {
    super("Wine not found.");
    this.name = "WineImageNotFoundError";
  }
}

export class WineImageUnsupportedTypeError extends Error {
  constructor() {
    super("Only JPEG, PNG, and WebP images are allowed.");
    this.name = "WineImageUnsupportedTypeError";
  }
}

export class WineImageTooLargeError extends Error {
  constructor() {
    super("Image must be under 10 MB.");
    this.name = "WineImageTooLargeError";
  }
}

export class WineImageStorageError extends Error {
  constructor(cause: unknown) {
    super("Image upload failed.");
    this.name = "WineImageStorageError";
    this.cause = cause;
  }
}

export class WineImagePersistenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "WineImagePersistenceError";
    this.cause = cause;
  }
}

export type UploadWineHeroImageInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
  file: File;
};

export type DeleteWineHeroImageInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
};

export async function uploadWineHeroImage(
  input: UploadWineHeroImageInput,
): Promise<string> {
  const { supabase, restaurantId, wineId, file } = input;

  await assertWineExists({ supabase, restaurantId, wineId });

  if (!ALLOWED_MIME.has(file.type)) {
    throw new WineImageUnsupportedTypeError();
  }

  if (file.size > MAX_BYTES) {
    throw new WineImageTooLargeError();
  }

  const ext = EXT_BY_MIME[file.type] ?? "jpg";
  const storagePath = `${restaurantId}/${wineId}.${ext}`;
  const body = Buffer.from(await file.arrayBuffer());

  try {
    await uploadSupabaseObject({
      supabase,
      bucket: WINE_IMAGE_BUCKET,
      path: storagePath,
      body,
      contentType: file.type,
      upsert: true,
    });
  } catch (error) {
    if (error instanceof SupabaseStorageError) {
      console.error("wine image upload failed:", error.cause ?? error);
      Sentry.captureException(error.cause ?? error, {
        tags: { surface: "wines", phase: "upload-image" },
        extra: { wineId, restaurantId, storagePath },
      });
      throw new WineImageStorageError(error);
    }
    throw error;
  }

  const publicUrl = getSupabasePublicUrl({
    supabase,
    bucket: WINE_IMAGE_BUCKET,
    path: storagePath,
  });

  const { error: updateError } = await supabase
    .from("wines")
    .update({ hero_image_url: publicUrl })
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId);

  if (updateError) {
    console.error("wine image URL update failed:", updateError);
    Sentry.captureException(updateError, {
      tags: { surface: "wines", phase: "update-image-url" },
      extra: { wineId, restaurantId, publicUrl },
    });
    throw new WineImagePersistenceError("Failed to save image URL.", updateError);
  }

  return publicUrl;
}

export async function deleteWineHeroImage(
  input: DeleteWineHeroImageInput,
): Promise<null> {
  const { supabase, restaurantId, wineId } = input;

  await assertWineExists({ supabase, restaurantId, wineId });

  const basePath = `${restaurantId}/${wineId}`;
  for (const ext of WINE_IMAGE_EXTENSIONS) {
    try {
      await removeSupabaseObjects({
        supabase,
        bucket: WINE_IMAGE_BUCKET,
        paths: [`${basePath}.${ext}`],
      });
    } catch {
      // Existing behavior treats object removal as best-effort; the DB URL
      // clear is the user-visible source of truth.
    }
  }

  const { error: updateError } = await supabase
    .from("wines")
    .update({ hero_image_url: null })
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId);

  if (updateError) {
    console.error("wine image URL clear failed:", updateError);
    Sentry.captureException(updateError, {
      tags: { surface: "wines", phase: "delete-image" },
      extra: { wineId, restaurantId },
    });
    throw new WineImagePersistenceError(
      "Failed to clear image URL.",
      updateError,
    );
  }

  return null;
}

async function assertWineExists(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
}): Promise<void> {
  const { supabase, restaurantId, wineId } = input;
  const { data: wine, error } = await supabase
    .from("wines")
    .select("id")
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId)
    .single();

  if (error || !wine) {
    throw new WineImageNotFoundError();
  }
}
