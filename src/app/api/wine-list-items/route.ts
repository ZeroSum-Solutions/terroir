import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { CreateWineListItemBodySchema } from "@/lib/api/wine-list-item-schemas";

export const runtime = "nodejs";

type SectionScope = {
  id: string;
  wine_list_id: string;
  wine_lists: { restaurant_id: string } | Array<{ restaurant_id: string }>;
};

function restaurantIdFor(section: SectionScope): string | undefined {
  const parent = Array.isArray(section.wine_lists)
    ? section.wine_lists[0]
    : section.wine_lists;
  return parent?.restaurant_id;
}

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, CreateWineListItemBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { data, error: sectionError } = await supabase
      .from("wine_list_sections")
      .select("id, wine_list_id, wine_lists!inner(restaurant_id)")
      .eq("id", body.section_id)
      .maybeSingle();
    if (sectionError) throw sectionError;
    const section = data as unknown as SectionScope | null;
    if (!section || restaurantIdFor(section) !== restaurantId) {
      return Errors.notFound("Section");
    }

    const { data: existing, error: positionError } = await supabase
      .from("wine_list_items")
      .select("position")
      .eq("section_id", body.section_id)
      .order("position", { ascending: false })
      .limit(1);
    if (positionError) throw positionError;
    const nextPosition = (existing?.[0]?.position ?? -1) + 1;

    const { data: item, error } = await supabase
      .from("wine_list_items")
      .insert({
        section_id: body.section_id,
        wine_id: body.wine_id,
        position: nextPosition,
        glass_price: body.glass_price ?? null,
        bottle_price: body.bottle_price ?? null,
        name_override: body.name_override ?? null,
      })
      .select("id")
      .single();
    if (error || !item) {
      throw error ?? new Error("wine-list item insert returned no row");
    }

    return NextResponse.json({ id: item.id });
  });
}
