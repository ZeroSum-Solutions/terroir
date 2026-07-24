import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { ReorderWineListItemsBodySchema } from "@/lib/api/wine-list-item-schemas";

export const runtime = "nodejs";

type ItemScope = {
  id: string;
  section_id: string;
  wine_list_sections: {
    wine_lists: { restaurant_id: string } | Array<{ restaurant_id: string }>;
  };
};

function restaurantIdFor(item: ItemScope): string | undefined {
  const parent = item.wine_list_sections.wine_lists;
  const wineList = Array.isArray(parent) ? parent[0] : parent;
  return wineList?.restaurant_id;
}

export async function PATCH(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, ReorderWineListItemsBodySchema);
    if (!parsed.ok) return parsed.response;
    const { orderedIds } = parsed.data;

    const { data, error: lookupError } = await supabase
      .from("wine_list_items")
      .select(
        "id, section_id, wine_list_sections!inner(wine_lists!inner(restaurant_id))",
      )
      .in("id", orderedIds);
    if (lookupError) throw lookupError;
    const items = (data ?? []) as unknown as ItemScope[];
    if (
      items.length !== orderedIds.length ||
      items.some((item) => restaurantIdFor(item) !== restaurantId)
    ) {
      return Errors.notFound("One or more items");
    }
    const sectionId = items[0].section_id;
    if (items.some((item) => item.section_id !== sectionId)) {
      return Errors.badRequest("All items must belong to the same section.");
    }

    const { error } = await supabase.rpc("reorder_wine_list_items", {
      p_ordered_ids: orderedIds,
    });
    if (error) throw error;

    return NextResponse.json({ ok: true });
  });
}
