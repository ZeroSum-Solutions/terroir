import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { ReorderWineListSectionsBodySchema } from "@/lib/api/wine-list-section-schemas";

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

export async function PATCH(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, ReorderWineListSectionsBodySchema);
    if (!parsed.ok) return parsed.response;
    const { orderedIds } = parsed.data;

    const { data, error: lookupError } = await supabase
      .from("wine_list_sections")
      .select("id, wine_list_id, wine_lists!inner(restaurant_id)")
      .in("id", orderedIds);
    if (lookupError) throw lookupError;
    const sections = (data ?? []) as unknown as SectionScope[];
    if (
      sections.length !== orderedIds.length ||
      sections.some((section) => restaurantIdFor(section) !== restaurantId)
    ) {
      return Errors.notFound("One or more sections");
    }

    const wineListId = sections[0].wine_list_id;
    if (sections.some((section) => section.wine_list_id !== wineListId)) {
      return Errors.badRequest(
        "All sections must belong to the same wine list.",
      );
    }

    // TER-020B keeps the existing sequential update behavior. The checked
    // row result prevents false success if a section is concurrently removed.
    for (const [position, id] of orderedIds.entries()) {
      const { data: updated, error } = await supabase
        .from("wine_list_sections")
        .update({ position })
        .eq("id", id)
        .eq("wine_list_id", wineListId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!updated) return Errors.notFound("Section");
    }

    return NextResponse.json({ ok: true });
  });
}
