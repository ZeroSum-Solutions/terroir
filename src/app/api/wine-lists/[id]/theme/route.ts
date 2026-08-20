import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { MenuThemeSchema, validateThemeContrast } from "@/lib/branding/theme";

export const runtime = "nodejs";

const BodySchema = z.strictObject({ theme: MenuThemeSchema });
type Params = Promise<{ id: string }>;

export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(() => postTheme(request, params));
}

async function postTheme(request: NextRequest, params: Params) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;
  const { id } = await params;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid theme.",
  });
  if (!parsed.ok) return parsed.response;
  const failures = validateThemeContrast(parsed.data.theme);
  if (failures.length > 0) {
    const failure = failures[0];
    return Errors.unprocessable(
      "theme_contrast_failed",
      `${failure.pair} is ${failure.ratio.toFixed(2)}:1; WCAG AA requires ${failure.required.toFixed(2)}:1. Choose a higher-contrast colour pair.`,
    );
  }

  const { data, error } = await supabase
    .from("wine_lists")
    .update({ theme: parsed.data.theme })
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .select("id, slug")
    .maybeSingle();
  if (error) throw error;
  if (!data) return Errors.notFound("Wine list");
  if (data.slug) revalidatePath(`/list/${data.slug}`);

  return NextResponse.json({ theme: parsed.data.theme });
}
