import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  UpdateWineListItemBodySchema,
  WineListItemIdParamsSchema,
} from "@/lib/api/wine-list-item-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;
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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineListItemIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data, error: lookupError } = await supabase
      .from("wine_list_items")
      .select(
        "id, section_id, wine_list_sections!inner(wine_lists!inner(restaurant_id))",
      )
      .eq("id", id)
      .maybeSingle();
    if (lookupError) throw lookupError;
    const target = data as unknown as ItemScope | null;
    if (!target || restaurantIdFor(target) !== restaurantId) {
      return Errors.notFound("Item");
    }

    const { data: removed, error } = await supabase
      .from("wine_list_items")
      .delete()
      .eq("id", id)
      .eq("section_id", target.section_id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!removed) return Errors.notFound("Item");

    return NextResponse.json({ ok: true });
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineListItemIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, UpdateWineListItemBodySchema, {
      message: "Invalid body.",
    });
    if (!parsedBody.ok) return parsedBody.response;
    const { id } = parsedParams.data;

    const { data, error: lookupError } = await supabase
      .from("wine_list_items")
      .select(
        "id, section_id, wine_list_sections!inner(wine_lists!inner(restaurant_id))",
      )
      .eq("id", id)
      .maybeSingle();
    if (lookupError) throw lookupError;
    const target = data as unknown as ItemScope | null;
    if (!target || restaurantIdFor(target) !== restaurantId) {
      return Errors.notFound("Item");
    }

    const { data: updated, error } = await supabase
      .from("wine_list_items")
      .update(parsedBody.data)
      .eq("id", id)
      .eq("section_id", target.section_id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) return Errors.notFound("Item");

    return NextResponse.json({ ok: true });
  });
}
