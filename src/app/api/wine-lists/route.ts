import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { CreateWineListBodySchema } from "@/lib/api/wine-list-lifecycle-schemas";
import { DEFAULT_SECTIONS } from "@/lib/wine-list/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, CreateWineListBodySchema);
    if (!parsed.ok) return parsed.response;
    const { name, description } = parsed.data;
    const insertPayload: {
      name: string;
      restaurant_id: string;
      description?: string;
    } = { name, restaurant_id: restaurantId };
    if (description) insertPayload.description = description;

    const { data: list, error: listError } = await supabase
      .from("wine_lists")
      .insert(insertPayload)
      .select("id")
      .single();
    if (listError || !list) {
      throw listError ?? new Error("wine-list insert returned no row");
    }

    const sectionInserts = DEFAULT_SECTIONS.map((sectionName, position) => ({
      wine_list_id: list.id,
      name: sectionName,
      position,
    }));
    const { error: sectionsError } = await supabase
      .from("wine_list_sections")
      .insert(sectionInserts);
    if (sectionsError) {
      const { data: cleaned, error: cleanupError } = await supabase
        .from("wine_lists")
        .delete()
        .eq("id", list.id)
        .eq("restaurant_id", restaurantId)
        .select("id")
        .maybeSingle();
      if (cleanupError) throw cleanupError;
      if (!cleaned) {
        throw new Error("failed to remove partial wine-list creation");
      }
      throw sectionsError;
    }

    return NextResponse.json({ id: list.id });
  });
}
