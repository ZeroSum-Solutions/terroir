import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { fileField, parseMultipart } from "@/lib/api/validation";
import { extractPaletteFromImage } from "@/lib/branding/palette";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const UploadSchema = z.strictObject({ file: fileField });

export async function POST(request: NextRequest) {
  return withApiHandler(() => postBrandKit(request));
}

async function postBrandKit(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseMultipart(request, UploadSchema, {
    message: "Invalid logo upload.",
  });
  if (!parsed.ok) return parsed.response;
  const file = parsed.data.file;
  if (file.size === 0) return Errors.badRequest("Logo file is empty.");
  if (file.size > MAX_LOGO_BYTES) return Errors.tooLarge("Logo must be under 2 MB.");
  if (!ALLOWED_MIME.has(file.type)) {
    return Errors.unsupportedMediaType("Use a PNG, JPEG, or WebP logo.");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let colors: string[];
  try {
    colors = await extractPaletteFromImage(bytes, file.type);
  } catch {
    return Errors.unprocessable(
      "invalid_logo",
      "The logo could not be decoded. Try exporting it again as PNG, JPEG, or WebP.",
    );
  }
  const logoUrl = `data:${file.type};base64,${bytes.toString("base64")}`;
  const { data, error } = await supabase
    .from("brand_kits")
    .upsert(
      {
        restaurant_id: restaurantId,
        logo_url: logoUrl,
        palette: { colors },
      },
      { onConflict: "restaurant_id" },
    )
    .select("id, logo_url, palette, proposals")
    .single();
  if (error) throw error;

  return NextResponse.json({
    brandKit: {
      id: data.id,
      logoUrl: data.logo_url,
      palette: data.palette,
      proposals: data.proposals,
    },
  });
}
