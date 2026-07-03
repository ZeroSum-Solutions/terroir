import { NextResponse, type NextRequest } from "next/server";
import {
  deleteWineHeroImage,
  uploadWineHeroImage,
  WineImageNotFoundError,
  WineImagePersistenceError,
  WineImageStorageError,
  WineImageTooLargeError,
  WineImageUnsupportedTypeError,
} from "@/domains/cellar/wine-image-service";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * POST /api/wines/[id]/image — upload a hero image for a wine.
 *
 * BND-057. Role-gated to owner | manager.
 * Stores the file in Supabase Storage under wine-images/{restaurantId}/{wineId}.{ext}.
 * Updates the wines.hero_image_url with the public URL.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // Parse multipart form data.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Errors.badRequest("Expected multipart/form-data.");
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return Errors.badRequest("Missing 'file' field.");
  }

  try {
    const heroImageUrl = await uploadWineHeroImage({
      supabase,
      restaurantId,
      wineId: id,
      file,
    });
    return NextResponse.json({ hero_image_url: heroImageUrl });
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

/**
 * DELETE /api/wines/[id]/image — remove the hero image.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  try {
    await deleteWineHeroImage({
      supabase,
      restaurantId,
      wineId: id,
    });
    return NextResponse.json({ hero_image_url: null });
  } catch (error) {
    if (error instanceof WineImageNotFoundError) {
      return Errors.notFound("Wine");
    }
    if (error instanceof WineImagePersistenceError) {
      return Errors.internal(error.message);
    }
    throw error;
  }
}
