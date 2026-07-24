import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import { WineListIdParamsSchema } from "@/lib/api/wine-list-lifecycle-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

type SourceItem = {
  wine_id: string;
  bottle_price: number | null;
  glass_price: number | null;
  glass_pour_ml: number | null;
  pour_size_mode: string | null;
  position: number;
  is_available: boolean | null;
  tasting_note: string | null;
  name_override: string | null;
  blurb: string | null;
  hidden: boolean | null;
};

type SourceSection = {
  name: string;
  position: number;
  wine_list_items?: SourceItem[];
};

export async function POST(
  _request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineListIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: sourceList, error: fetchError } = await supabase
      .from("wine_lists")
      .select("name, description, template")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!sourceList) return Errors.notFound("Wine list");

    const { data: sourceSections, error: sectionsError } = await supabase
      .from("wine_list_sections")
      .select(
        "name, position, wine_list_items(wine_id, bottle_price, glass_price, glass_pour_ml, pour_size_mode, position, is_available, tasting_note, name_override, blurb, hidden)",
      )
      .eq("wine_list_id", id)
      .order("position");
    if (sectionsError) throw sectionsError;
    if (!sourceSections) {
      throw new Error("clone source sections returned no rows");
    }

    const { data: cloneList, error: createError } = await supabase
      .from("wine_lists")
      .insert({
        name: `${sourceList.name} (copy)`,
        description: sourceList.description,
        template: sourceList.template ?? "classic",
        restaurant_id: restaurantId,
        is_published: false,
        archived: false,
        slug: null,
      })
      .select("id")
      .single();
    if (createError || !cloneList) {
      throw createError ?? new Error("clone list insert returned no row");
    }

    const cleanupClone = async () => {
      const { data: removed, error } = await supabase
        .from("wine_lists")
        .delete()
        .eq("id", cloneList.id)
        .eq("restaurant_id", restaurantId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!removed) throw new Error("failed to remove partial wine-list clone");
    };

    for (const section of sourceSections as SourceSection[]) {
      const { data: newSection, error: sectionInsertError } = await supabase
        .from("wine_list_sections")
        .insert({
          wine_list_id: cloneList.id,
          name: section.name,
          position: section.position,
        })
        .select("id")
        .single();
      if (sectionInsertError || !newSection) {
        await cleanupClone();
        throw sectionInsertError ?? new Error("clone section insert returned no row");
      }

      const items = section.wine_list_items ?? [];
      if (items.length === 0) continue;
      const { error: itemsError } = await supabase
        .from("wine_list_items")
        .insert(
          items.map((item) => ({
            section_id: newSection.id,
            wine_id: item.wine_id,
            bottle_price: item.bottle_price,
            glass_price: item.glass_price,
            glass_pour_ml: item.glass_pour_ml,
            pour_size_mode: item.pour_size_mode ?? "bottle_only",
            position: item.position,
            is_available: item.is_available ?? true,
            tasting_note: item.tasting_note,
            name_override: item.name_override,
            blurb: item.blurb,
            hidden: item.hidden ?? false,
          })),
        );
      if (itemsError) {
        await cleanupClone();
        throw itemsError;
      }
    }

    return NextResponse.json({ id: cloneList.id });
  });
}
