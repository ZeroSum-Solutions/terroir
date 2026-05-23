import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

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

  // Verify the wine exists and belongs to this restaurant.
  const { data: wine, error: fetchError } = await supabase
    .from("wines")
    .select("id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError || !wine) {
    return Errors.notFound("Wine");
  }

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

  if (!ALLOWED_MIME.has(file.type)) {
    return Errors.unsupportedMediaType(
      "Only JPEG, PNG, and WebP images are allowed.",
    );
  }

  if (file.size > MAX_BYTES) {
    return Errors.tooLarge("Image must be under 10 MB.");
  }

  // Determine file extension from MIME type.
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const ext = extMap[file.type] ?? "jpg";

  // Storage path: {restaurantId}/{wineId}.{ext}
  const storagePath = `${restaurantId}/${id}.${ext}`;

  const arrayBuf = await file.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const { error: uploadError } = await supabase.storage
    .from("wine-images")
    .upload(storagePath, buf, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    console.error("wine image upload failed:", uploadError);
    Sentry.captureException(uploadError, {
      tags: { surface: "wines", phase: "upload-image" },
      extra: { wineId: id, restaurantId, storagePath },
    });
    return Errors.internal("Image upload failed.");
  }

  // Get the public URL.
  const { data: publicUrlData } = supabase.storage
    .from("wine-images")
    .getPublicUrl(storagePath);

  const publicUrl = publicUrlData?.publicUrl ?? "";

  // Update the wine row with the image URL.
  const { error: updateError } = await supabase
    .from("wines")
    .update({ hero_image_url: publicUrl })
    .eq("id", id)
    .eq("restaurant_id", restaurantId);

  if (updateError) {
    console.error("wine image URL update failed:", updateError);
    Sentry.captureException(updateError, {
      tags: { surface: "wines", phase: "update-image-url" },
      extra: { wineId: id, restaurantId, publicUrl },
    });
    return Errors.internal("Failed to save image URL.");
  }

  return NextResponse.json({ hero_image_url: publicUrl });
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

  // Verify the wine exists and belongs to this restaurant.
  const { data: wine, error: fetchError } = await supabase
    .from("wines")
    .select("id, hero_image_url")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError || !wine) {
    return Errors.notFound("Wine");
  }

  // Remove from storage.
  const storagePath = `${restaurantId}/${id}`;
  // Try common extensions.
  const exts = ["jpg", "png", "webp"];
  for (const ext of exts) {
    const { error: rmError } = await supabase.storage
      .from("wine-images")
      .remove([`${storagePath}.${ext}`]);
    // Ignore errors — file may not exist.
    void rmError;
  }

  // Clear the URL on the wine row.
  const { error: updateError } = await supabase
    .from("wines")
    .update({ hero_image_url: null })
    .eq("id", id)
    .eq("restaurant_id", restaurantId);

  if (updateError) {
    console.error("wine image URL clear failed:", updateError);
    Sentry.captureException(updateError, {
      tags: { surface: "wines", phase: "delete-image" },
      extra: { wineId: id, restaurantId },
    });
    return Errors.internal("Failed to clear image URL.");
  }

  return NextResponse.json({ hero_image_url: null });
}
