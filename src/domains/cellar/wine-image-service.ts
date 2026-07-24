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

  const existingWine = await assertWineExists({
    supabase,
    restaurantId,
    wineId,
  });

  if (!ALLOWED_MIME.has(file.type)) {
    throw new WineImageUnsupportedTypeError();
  }

  if (file.size > MAX_BYTES) {
    throw new WineImageTooLargeError();
  }

  const ext = EXT_BY_MIME[file.type] ?? "jpg";
  const storagePath = `${restaurantId}/${wineId}.${ext}`;
  const body = Buffer.from(await file.arrayBuffer());
  if (!hasExpectedImageSignature(file.type, body)) {
    throw new WineImageUnsupportedTypeError();
  }

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

  if (existingWine.hero_image_url !== publicUrl) {
    const { data: updatedWine, error: updateError } = await supabase
      .from("wines")
      .update({ hero_image_url: publicUrl })
      .eq("id", wineId)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error("wine image URL update failed:", updateError);
      Sentry.captureException(updateError, {
        tags: { surface: "wines", phase: "update-image-url" },
        extra: { wineId, restaurantId, publicUrl },
      });
      await removeStoredImageBestEffort({ supabase, storagePath });
      throw new WineImagePersistenceError(
        "Failed to save image URL.",
        updateError,
      );
    }
    if (!updatedWine) {
      await removeStoredImageBestEffort({ supabase, storagePath });
      throw new WineImageNotFoundError();
    }
  }

  const basePath = `${restaurantId}/${wineId}`;
  for (const oldExt of WINE_IMAGE_EXTENSIONS) {
    if (oldExt === ext) continue;
    await removeStoredImage({
      supabase,
      storagePath: `${basePath}.${oldExt}`,
      wineId,
      restaurantId,
      phase: "remove-obsolete-image",
    });
  }

  return publicUrl;
}

export async function deleteWineHeroImage(
  input: DeleteWineHeroImageInput,
): Promise<null> {
  const { supabase, restaurantId, wineId } = input;

  await assertWineExists({ supabase, restaurantId, wineId });

  const { data: updatedWine, error: updateError } = await supabase
    .from("wines")
    .update({ hero_image_url: null })
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId)
    .select("id")
    .maybeSingle();

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
  if (!updatedWine) throw new WineImageNotFoundError();

  const basePath = `${restaurantId}/${wineId}`;
  for (const ext of WINE_IMAGE_EXTENSIONS) {
    await removeStoredImage({
      supabase,
      storagePath: `${basePath}.${ext}`,
      wineId,
      restaurantId,
      phase: "delete-image-object",
    });
  }

  return null;
}

async function assertWineExists(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
}): Promise<{ id: string; hero_image_url: string | null }> {
  const { supabase, restaurantId, wineId } = input;
  const { data: wine, error } = await supabase
    .from("wines")
    .select("id, hero_image_url")
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (error) {
    throw new WineImagePersistenceError("Failed to look up wine.", error);
  }
  if (!wine) throw new WineImageNotFoundError();
  return wine;
}

async function removeStoredImageBestEffort(input: {
  supabase: SupabaseClient<Database>;
  storagePath: string;
}): Promise<void> {
  try {
    await removeSupabaseObjects({
      supabase: input.supabase,
      bucket: WINE_IMAGE_BUCKET,
      paths: [input.storagePath],
    });
  } catch {
    // The database URL is authoritative; orphan cleanup is best-effort.
  }
}

async function removeStoredImage(input: {
  supabase: SupabaseClient<Database>;
  storagePath: string;
  wineId: string;
  restaurantId: string;
  phase: string;
}): Promise<void> {
  try {
    await removeSupabaseObjects({
      supabase: input.supabase,
      bucket: WINE_IMAGE_BUCKET,
      paths: [input.storagePath],
    });
  } catch (error) {
    if (error instanceof SupabaseStorageError) {
      console.error("wine image cleanup failed:", error.cause ?? error);
      Sentry.captureException(error.cause ?? error, {
        tags: { surface: "wines", phase: input.phase },
        extra: {
          wineId: input.wineId,
          restaurantId: input.restaurantId,
          storagePath: input.storagePath,
        },
      });
      throw new WineImageStorageError(error);
    }
    throw error;
  }
}

function hasExpectedImageSignature(mime: string, body: Buffer): boolean {
  if (mime === "image/jpeg") {
    return (
      body.length >= 3 &&
      body[0] === 0xff &&
      body[1] === 0xd8 &&
      body[2] === 0xff
    );
  }
  if (mime === "image/png") {
    return (
      body.length >= 8 &&
      body.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    );
  }
  if (mime === "image/webp") {
    return (
      body.length >= 12 &&
      body.subarray(0, 4).toString("ascii") === "RIFF" &&
      body.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}
