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

export type SaveWineLabelPhotoInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
  file: File;
};

export type SaveWineLabelPhotoOutcome = {
  /** False when the wine already had an image, which is the ordinary outcome
   * of re-scanning a bottle already in the cellar — not a failure. */
  applied: boolean;
  heroImageUrl: string | null;
};

/**
 * Makes a bottle scan's label photo the wine's hero image, but only if the
 * wine has none.
 *
 * Distinct from uploadWineHeroImage, which is a manager deliberately choosing
 * a picture and may replace one. This is a byproduct of scanning: it fills an
 * empty slot and can never overwrite a chosen image, which is why it is open
 * to any member rather than owner/manager.
 *
 * The claim happens BEFORE the upload, not after. The object path is
 * deterministic, so the URL is known in advance and the row can be claimed
 * with a conditional update — without that ordering, a manager's upload
 * landing between the check and the write would have its object overwritten
 * by this one while the URL still pointed at it.
 */
export async function saveWineLabelPhoto(
  input: SaveWineLabelPhotoInput,
): Promise<SaveWineLabelPhotoOutcome> {
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
  const publicUrl = getSupabasePublicUrl({
    supabase,
    bucket: WINE_IMAGE_BUCKET,
    path: storagePath,
  });

  const { data: claimed, error: claimError } = await supabase
    .from("wines")
    .update({ hero_image_url: publicUrl })
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId)
    .is("hero_image_url", null)
    .select("id");

  if (claimError) {
    console.error("wine label photo claim failed:", claimError);
    Sentry.captureException(claimError, {
      tags: { surface: "wines", phase: "claim-label-photo" },
      extra: { wineId, restaurantId },
    });
    throw new WineImagePersistenceError("Failed to save image URL.", claimError);
  }

  if (!claimed || claimed.length === 0) {
    // The wine already has an image. Nothing was uploaded, so nothing was
    // overwritten — the existing picture stands.
    return { applied: false, heroImageUrl: null };
  }

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
    // The claim is already written. Release it, or the wine keeps a
    // hero_image_url pointing at an object that was never stored.
    await supabase
      .from("wines")
      .update({ hero_image_url: null })
      .eq("id", wineId)
      .eq("restaurant_id", restaurantId)
      .eq("hero_image_url", publicUrl);

    if (error instanceof SupabaseStorageError) {
      console.error("wine label photo upload failed:", error.cause ?? error);
      Sentry.captureException(error.cause ?? error, {
        tags: { surface: "wines", phase: "upload-label-photo" },
        extra: { wineId, restaurantId, storagePath },
      });
      throw new WineImageStorageError(error);
    }
    throw error;
  }

  return { applied: true, heroImageUrl: publicUrl };
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
