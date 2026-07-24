import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  isUniqueViolation,
  normalizeWineListSlug,
  PublishWineListBodySchema,
  WineListIdParamsSchema,
} from "@/lib/api/wine-list-lifecycle-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineListIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, PublishWineListBodySchema, {
      allowEmpty: true,
    });
    if (!parsedBody.ok) return parsedBody.response;
    const { id } = parsedParams.data;

    const { data: list, error: fetchError } = await supabase
      .from("wine_lists")
      .select("slug, restaurant_id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!list) return Errors.notFound("Wine list");

    let slug: string | null = list.slug;
    if (parsedBody.data.slug !== undefined) {
      const customSlug = normalizeWineListSlug(parsedBody.data.slug);
      if (!customSlug.ok) {
        return Errors.unprocessable("invalid_slug", customSlug.message);
      }
      const { data: existing, error: slugLookupError } = await supabase
        .from("wine_lists")
        .select("id")
        .eq("slug", customSlug.value)
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
      slug = customSlug.value;
    }

    if (!slug) {
      const { data: restaurant, error: restaurantError } = await supabase
        .from("restaurants")
        .select("name")
        .eq("id", list.restaurant_id)
        .maybeSingle();
      if (restaurantError) throw restaurantError;
      if (!restaurant) throw new Error("wine-list restaurant was not found");

      const { data: generatedSlug, error: slugError } = await supabase.rpc(
        "generate_slug",
        { input: restaurant.name || "wine-list" },
      );
      if (slugError) throw slugError;
      if (!generatedSlug) throw new Error("slug generation returned no value");
      slug = generatedSlug;
    }

    const { data: published, error: updateError } = await supabase
      .from("wine_lists")
      .update({
        is_published: true,
        last_published_at: new Date().toISOString(),
        slug,
      })
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (isUniqueViolation(updateError)) {
      return Errors.conflict(
        "slug_collision",
        "This slug is already in use.",
      );
    }
    if (updateError) throw updateError;
    if (!published) return Errors.notFound("Wine list");

    return NextResponse.json({ slug });
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
      .select("id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!list) return Errors.notFound("Wine list");

    const { data: unpublished, error: updateError } = await supabase
      .from("wine_lists")
      .update({ is_published: false, slug: null })
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!unpublished) return Errors.notFound("Wine list");

    return NextResponse.json({ ok: true });
  });
}
