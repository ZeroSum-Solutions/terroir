import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  isUniqueViolation,
  normalizeWineListSlug,
  UpdateWineListBodySchema,
  WineListIdParamsSchema,
} from "@/lib/api/wine-list-lifecycle-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineListIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, UpdateWineListBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { id } = parsedParams.data;
    const allowed = { ...parsedBody.data };

    if (allowed.slug !== undefined) {
      const slug = normalizeWineListSlug(allowed.slug);
      if (!slug.ok) {
        return Errors.unprocessable("invalid_slug", slug.message);
      }
      const { data: existing, error: slugLookupError } = await supabase
        .from("wine_lists")
        .select("id")
        .eq("slug", slug.value)
        .eq("restaurant_id", restaurantId)
        .neq("id", id)
        .maybeSingle();
      if (slugLookupError) throw slugLookupError;
      if (existing) {
        return Errors.conflict(
          "slug_collision",
          "This slug is already in use by another list in your restaurant.",
        );
      }
      allowed.slug = slug.value;
    }

    const { data: updated, error } = await supabase
      .from("wine_lists")
      .update(allowed)
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (isUniqueViolation(error)) {
      return Errors.conflict(
        "slug_collision",
        "This slug is already in use.",
      );
    }
    if (error) throw error;
    if (!updated) return Errors.notFound("Wine list");

    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(
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

    const { data: list, error: fetchError } = await supabase
      .from("wine_lists")
      .select("archived")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!list) return Errors.notFound("Wine list");
    if (!list.archived) {
      return Errors.conflict(
        "must_archive_first",
        "Active lists must be archived before they can be deleted.",
      );
    }

    const { data: removed, error } = await supabase
      .from("wine_lists")
      .delete()
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!removed) return Errors.notFound("Wine list");

    return NextResponse.json({ ok: true });
  });
}
