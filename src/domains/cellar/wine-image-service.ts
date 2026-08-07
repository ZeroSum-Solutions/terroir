import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSupabaseSignedUrl,
  createSupabaseSignedUrls,
  removeSupabaseObjects,
  SupabaseStorageError,
  uploadSupabaseObject,
} from "@/adapters/storage";
import type { Database } from "@/types/database";

const WINE_IMAGE_BUCKET = "wine-images";
const MAX_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 300;
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
      console.error("wine image upload failed.");
      Sentry.captureException(error.cause ?? error, {
        tags: { surface: "wines", phase: "upload-image" },
        extra: { wineId, restaurantId },
      });
      throw new WineImageStorageError(error);
    }
    throw error;
  }

  if (existingWine.hero_image_url !== storagePath) {
    const { data: updatedWine, error: updateError } = await supabase
      .from("wines")
      .update({ hero_image_url: storagePath })
      .eq("id", wineId)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error("wine image path update failed.");
      Sentry.captureException(updateError, {
        tags: { surface: "wines", phase: "update-image-url" },
        extra: { wineId, restaurantId },
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

  const signedUrl = await createWineHeroImageSignedUrl({
    supabase,
    restaurantId,
    wineId,
    storagePath,
  });
  if (!signedUrl) {
    throw new WineImageStorageError(
      new Error("Canonical wine image path could not be signed."),
    );
  }
  return signedUrl;
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
    console.error("wine image path clear failed.");
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

export async function createWineHeroImageSignedUrl(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
  storagePath: string | null;
}): Promise<string | null> {
  const { supabase, restaurantId, wineId, storagePath } = input;
  if (!storagePath || !isWineImagePath(storagePath, restaurantId, wineId)) {
    return null;
  }

  try {
    return await createSupabaseSignedUrl({
      supabase,
      bucket: WINE_IMAGE_BUCKET,
      path: storagePath,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch (error) {
    if (error instanceof SupabaseStorageError) {
      throw new WineImageStorageError(error);
    }
    throw error;
  }
}

export async function createWineHeroImageSignedUrls(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  images: Array<{ wineId: string; storagePath: string | null }>;
}): Promise<Map<string, string>> {
  const { supabase, restaurantId, images } = input;
  const validImages = images.filter(
    (image): image is { wineId: string; storagePath: string } =>
      image.storagePath !== null &&
      isWineImagePath(image.storagePath, restaurantId, image.wineId),
  );
  if (validImages.length === 0) return new Map();

  try {
    const signedUrlsByPath = await createSupabaseSignedUrls({
      supabase,
      bucket: WINE_IMAGE_BUCKET,
      paths: validImages.map((image) => image.storagePath),
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
    return new Map(
      validImages.flatMap((image) => {
        const signedUrl = signedUrlsByPath.get(image.storagePath);
        return signedUrl ? [[image.wineId, signedUrl] as const] : [];
      }),
    );
  } catch (error) {
    if (error instanceof SupabaseStorageError) {
      throw new WineImageStorageError(error);
    }
    throw error;
  }
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
      console.error("wine image cleanup failed.");
      Sentry.captureException(error.cause ?? error, {
        tags: { surface: "wines", phase: input.phase },
        extra: {
          wineId: input.wineId,
          restaurantId: input.restaurantId,
        },
      });
      throw new WineImageStorageError(error);
    }
    throw error;
  }
}

function isWineImagePath(
  storagePath: string,
  restaurantId: string,
  wineId: string,
): boolean {
  return new RegExp(
    `^${escapeRegex(restaurantId)}/${escapeRegex(wineId)}\\.(jpg|png|webp)$`,
  ).test(storagePath);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
