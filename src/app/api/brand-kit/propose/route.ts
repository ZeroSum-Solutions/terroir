import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { buildWineListSummary } from "@/lib/branding/list-summary";
import {
  generateMenuThemes,
  MenuDesignError,
} from "@/lib/branding/menu-design";
import {
  BrandKitPaletteSchema,
  MenuThemeSchema,
} from "@/lib/branding/theme";
import type { Json } from "@/types/database";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.strictObject({
  listId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(500).optional(),
  currentTheme: MenuThemeSchema.optional(),
});

type ListRow = Parameters<typeof buildWineListSummary>[0];

export async function POST(request: NextRequest) {
  return withApiHandler(() => postProposals(request));
}

async function postProposals(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid theme request.",
  });
  if (!parsed.ok) return parsed.response;

  const [{ data: kit, error: kitError }, { data: list, error: listError }] =
    await Promise.all([
      supabase
        .from("brand_kits")
        .select("palette")
        .eq("restaurant_id", restaurantId)
        .maybeSingle(),
      supabase
        .from("wine_lists")
        .select(
          "name, wine_list_sections(name, wine_list_items(wines(producer, name, vintage, varietal, region)))",
        )
        .eq("id", parsed.data.listId)
        .eq("restaurant_id", restaurantId)
        .maybeSingle(),
    ]);
  if (kitError) throw kitError;
  if (listError) throw listError;
  if (!kit) return Errors.notFound("Brand kit");
  if (!list) return Errors.notFound("Wine list");

  const palette = BrandKitPaletteSchema.safeParse(kit.palette);
  if (!palette.success) {
    return Errors.unprocessable(
      "invalid_brand_palette",
      "The saved brand palette is invalid. Upload the logo again.",
    );
  }

  try {
    const proposals = await generateMenuThemes({
      palette: palette.data,
      listSummary: buildWineListSummary(list as unknown as ListRow),
      instruction: parsed.data.instruction,
      currentTheme: parsed.data.currentTheme,
    });
    const { error } = await supabase
      .from("brand_kits")
      .update({ proposals: proposals as unknown as Json })
      .eq("restaurant_id", restaurantId)
      .select("id")
      .single();
    if (error) throw error;
    return NextResponse.json({ proposals });
  } catch (error) {
    if (error instanceof MenuDesignError) {
      return Errors.badGateway(
        "Theme generation returned invalid designs. Try again.",
      );
    }
    throw error;
  }
}
