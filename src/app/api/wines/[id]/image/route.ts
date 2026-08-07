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
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseMultipart, parseParams } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";
import { WineImageFormSchema } from "@/lib/api/wine-provider-mutation-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;
type ImageMutationBody =
  | { hero_image_url: string | null }
  | { error: { code: string; message: string } };

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
      const file = parsedForm.data.file;
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      return await idempotentMutationResponse<ImageMutationBody>({
        request,
        supabase,
        restaurantId,
        operationId: "api:POST:/api/wines/{param}/image",
        payload: {
          id: parsedParams.data.id,
          file: { size: file.size, type: file.type },
        },
        binaryParts: [fileBytes],
        releaseOnError: false,
        handler: async () => {
          try {
            const heroImageUrl = await uploadWineHeroImage({
              supabase,
              restaurantId,
              wineId: parsedParams.data.id,
              file,
            });
            return {
              status: 200,
              body: { hero_image_url: heroImageUrl },
            };
          } catch (error) {
            const result = deterministicImageError(error);
            if (result) return result;
            throw error;
          }
        },
      });
    } catch (error) {
      return imageErrorResponse(error, "Image upload failed.");
    }
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;

    try {
      return await idempotentMutationResponse<ImageMutationBody>({
        request,
        supabase,
        restaurantId,
        operationId: "api:DELETE:/api/wines/{param}/image",
        payload: { id: parsedParams.data.id },
        releaseOnError: false,
        handler: async () => {
          try {
            await deleteWineHeroImage({
              supabase,
              restaurantId,
              wineId: parsedParams.data.id,
            });
            return { status: 200, body: { hero_image_url: null } };
          } catch (error) {
            const result = deterministicImageError(error);
            if (result) return result;
            throw error;
          }
        },
      });
    } catch (error) {
      return imageErrorResponse(error, "Failed to remove image.");
    }
  });
}

function deterministicImageError(error: unknown) {
  if (error instanceof WineImageNotFoundError) {
    return {
      status: 404,
      body: { error: { code: "not_found", message: "Wine not found." } },
    };
  }
  if (error instanceof WineImageUnsupportedTypeError) {
    return {
      status: 415,
      body: {
        error: { code: "unsupported_media_type", message: error.message },
      },
    };
  }
  if (error instanceof WineImageTooLargeError) {
    return {
      status: 413,
      body: { error: { code: "too_large", message: error.message } },
    };
  }
  return null;
}

function imageErrorResponse(error: unknown, message: string) {
  if (error instanceof WineImageStorageError) return Errors.internal(message);
  if (error instanceof WineImagePersistenceError) return Errors.internal(message);
  throw error;
}
