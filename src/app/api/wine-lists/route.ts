import { NextResponse, type NextRequest } from "next/server";
import { requireCapability, requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson } from "@/lib/api/validation";
import { CreateWineListBodySchema } from "@/lib/api/wine-list-lifecycle-schemas";
import { DEFAULT_SECTIONS } from "@/lib/wine-list/types";

export const runtime = "nodejs";

/** Returns all wine lists belonging to the active restaurant. */
export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine-list:view");
    if (auth instanceof NextResponse) return auth;

    const { data, error } = await auth.supabase
      .from("wine_lists")
      .select("*, wine_list_sections(wine_list_items(id))")
      .eq("restaurant_id", auth.restaurantId)
      .order("updated_at", { ascending: false });
    if (error) throw error;

    const lists = (data ?? []).map((list) => {
      const wineCount = (list.wine_list_sections ?? []).reduce(
        (count, section) => count + (section.wine_list_items?.length ?? 0),
        0,
      );
      const { wine_list_sections: _sections, ...metadata } = list;
      return { ...metadata, wine_count: wineCount };
    });

    return NextResponse.json({ lists });
  });
}

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, CreateWineListBodySchema);
    if (!parsed.ok) return parsed.response;
    const { name, description } = parsed.data;

    return idempotentMutationResponse<{ id: string }>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/wine-lists",
      payload: { name, description },
      releaseOnError: false,
      handler: async () => {
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

        const sectionInserts = DEFAULT_SECTIONS.map(
          (sectionName, position) => ({
            wine_list_id: list.id,
            name: sectionName,
            position,
          }),
        );
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

        return { status: 200, body: { id: list.id } };
      },
    });
  });
}
