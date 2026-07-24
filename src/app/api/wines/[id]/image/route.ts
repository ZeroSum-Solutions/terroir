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
import { withApiHandler } from "@/lib/api/handler";
import { parseMultipart, parseParams } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";
import { WineImageFormSchema } from "@/lib/api/wine-provider-mutation-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedForm = await parseMultipart(request, WineImageFormSchema);
    if (!parsedForm.ok) return parsedForm.response;

    try {
      const heroImageUrl = await uploadWineHeroImage({
        supabase,
        restaurantId,
        wineId: parsedParams.data.id,
        file: parsedForm.data.file,
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
        return Errors.internal("Failed to save image.");
      }
      throw error;
    }
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;

    try {
      await deleteWineHeroImage({
        supabase,
        restaurantId,
        wineId: parsedParams.data.id,
      });
      return NextResponse.json({ hero_image_url: null });
    } catch (error) {
      if (error instanceof WineImageNotFoundError) {
        return Errors.notFound("Wine");
      }
      if (error instanceof WineImagePersistenceError) {
        return Errors.internal("Failed to remove image.");
      }
      if (error instanceof WineImageStorageError) {
        return Errors.internal("Failed to remove image.");
      }
      throw error;
    }
  });
}
