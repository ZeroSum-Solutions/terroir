import { NextResponse, type NextRequest } from "next/server";
import {
  saveWineLabelPhoto,
  WineImageNotFoundError,
  WineImagePersistenceError,
  WineImageStorageError,
  WineImageTooLargeError,
  WineImageUnsupportedTypeError,
} from "@/domains/cellar/wine-image-service";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * POST /api/wines/[id]/label-photo — keep a bottle scan's photo as the wine's
 * picture, if it has none.
 *
 * Deliberately not the same route as POST /api/wines/[id]/image. That one is a
 * manager choosing a hero image and may replace one, so it is gated to
 * owner|manager. This one only ever fills an empty slot — it cannot overwrite
 * a chosen picture — so it is open to any member: whoever is allowed to add
 * the wine by scanning it is allowed to give it its first photo.
 *
 * A wine that already has an image is a 200 with `applied: false`, not an
 * error. Re-scanning a bottle already in the cellar is ordinary.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Errors.badRequest("Expected multipart/form-data.");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Errors.badRequest("Missing 'file' field.");
  }

  try {
    const outcome = await saveWineLabelPhoto({
      supabase,
      restaurantId,
      wineId: id,
      file,
    });
    return NextResponse.json({
      hero_image_url: outcome.heroImageUrl,
      applied: outcome.applied,
    });
  } catch (error) {
    if (error instanceof WineImageNotFoundError) {
      return Errors.notFound("Wine");
    }
    if (error instanceof WineImageUnsupportedTypeError) {
      return Errors.unsupportedMediaType(error.message);
    }
    if (error instanceof WineImageTooLargeError) {
      return Errors.tooLarge(error.message);
    }
    if (error instanceof WineImageStorageError) {
      return Errors.internal("Image upload failed.");
    }
    if (error instanceof WineImagePersistenceError) {
      return Errors.internal(error.message);
    }
    throw error;
  }
}
