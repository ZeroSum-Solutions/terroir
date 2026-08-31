import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { fileField, parseJson, parseMultipart } from "@/lib/api/validation";
import { extractPaletteFromImage } from "@/lib/branding/palette";
import {
  fetchSiteBranding,
  SiteBrandingError,
  validateBusinessUrl,
} from "@/lib/branding/site-brand";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
/**
 * LIST-05 — every raster format `extractPaletteFromImage` can actually decode.
 * It was `image/png` alone, which rejected the JPEG most people have to hand
 * and which the file picker then hid entirely — a large part of "the brand kit
 * isn't working". Anything that is not a PNG goes through the Chromium
 * rasterizer that has been in `palette.ts` since it was written.
 *
 * SVG is deliberately excluded: it can reference remote resources, and the
 * rasterizer would fetch them from inside our own network.
 */
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);
const SUPPORTED_LOGO_MESSAGE =
  "Supported logo formats: PNG, JPEG, WebP, GIF, BMP or AVIF, under 2 MB.";
const UploadSchema = z.strictObject({ file: fileField });
const UrlSchema = z.strictObject({ url: z.string().min(1).max(2048) });

type Client = SupabaseClient<Database>;

export async function POST(request: NextRequest) {
  return withApiHandler(() => postBrandKit(request));
}

async function postBrandKit(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const contentType = request.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? fromBusinessUrl(request, supabase, restaurantId)
    : fromLogoUpload(request, supabase, restaurantId);
}

/** LIST-05 — a business URL, read through Firecrawl's `branding` format. */
async function fromBusinessUrl(
  request: NextRequest,
  supabase: Client,
  restaurantId: string,
) {
  const parsed = await parseJson(request, UrlSchema, {
    message: "Invalid website address.",
  });
  if (!parsed.ok) return parsed.response;

  const validated = validateBusinessUrl(parsed.data.url);
  if (!validated.ok) {
    return Errors.badRequest(validated.reason, undefined, "invalid_business_url");
  }

  try {
    const branding = await fetchSiteBranding(validated.url);
    return saveBrandKit(
      supabase,
      restaurantId,
      branding.colors.slice(0, 6),
      branding.logoUrl,
    );
  } catch (error) {
    if (error instanceof SiteBrandingError) {
      return error.code === "brand_kit_url_unavailable"
        ? Errors.badGateway(error.message)
        : Errors.unprocessable(error.code, error.message);
    }
    throw error;
  }
}

async function fromLogoUpload(
  request: NextRequest,
  supabase: Client,
  restaurantId: string,
) {
  const parsed = await parseMultipart(request, UploadSchema, {
    message: "Invalid logo upload.",
  });
  if (!parsed.ok) return parsed.response;
  const file = parsed.data.file;
  if (file.size === 0) return Errors.badRequest("Logo file is empty.");
  if (file.size > MAX_LOGO_BYTES) return Errors.tooLarge("Logo must be under 2 MB.");
  if (!ALLOWED_MIME.has(file.type.toLowerCase())) {
    return Errors.unprocessable("unsupported_logo_format", SUPPORTED_LOGO_MESSAGE);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let colors: string[];
  try {
    colors = await extractPaletteFromImage(bytes, file.type.toLowerCase());
  } catch {
    return Errors.unprocessable(
      "invalid_logo",
      `The logo could not be decoded. ${SUPPORTED_LOGO_MESSAGE}`,
    );
  }
  if (colors.length === 0) {
    return Errors.unprocessable(
      "invalid_logo",
      "No colours could be read from that logo.",
    );
  }
  return saveBrandKit(
    supabase,
    restaurantId,
    colors,
    `data:${file.type.toLowerCase()};base64,${bytes.toString("base64")}`,
  );
}

async function saveBrandKit(
  supabase: Client,
  restaurantId: string,
  colors: string[],
  logoUrl: string | null,
) {
  const { data, error } = await supabase
    .from("brand_kits")
    .upsert(
      {
        restaurant_id: restaurantId,
        logo_url: logoUrl,
        palette: { colors },
        proposals: null,
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
