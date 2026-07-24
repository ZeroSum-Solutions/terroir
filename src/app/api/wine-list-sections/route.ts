import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { CreateWineListSectionBodySchema } from "@/lib/api/wine-list-section-schemas";

export const runtime = "nodejs";

/**
 * BND-025 / DEBT-005 — wire 'Add section' button in the wine-list editor.
 *
 * POST /api/wine-list-sections creates a new section at the end of the
 * given list. Defense-in-depth: we verify the wine_list_id belongs to a
 * list owned by the caller's restaurant before inserting, so a leaked id
 * from another tenant 404s instead of silently inserting.
 */

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, CreateWineListSectionBodySchema, {
      message: "Invalid body.",
    });
    if (!parsed.ok) return parsed.response;
    const { wine_list_id, name } = parsed.data;

    const { data: ownerCheck, error: ownerError } = await supabase
      .from("wine_lists")
      .select("id")
      .eq("id", wine_list_id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (ownerError) throw ownerError;
    if (!ownerCheck) return Errors.notFound("Wine list");

    const { count, error: countError } = await supabase
      .from("wine_list_sections")
      .select("id", { count: "exact", head: true })
      .eq("wine_list_id", wine_list_id);
    if (countError) throw countError;

    const position = count ?? 0;
    const { data: inserted, error: insertError } = await supabase
      .from("wine_list_sections")
      .insert({ wine_list_id, name, position })
      .select("id, wine_list_id, name, position, created_at")
      .single();
    if (insertError || !inserted) {
      throw (
        insertError ?? new Error("wine-list section insert returned no row")
      );
    }

    return NextResponse.json(inserted, { status: 201 });
  });
}
