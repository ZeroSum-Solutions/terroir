import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function POST(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // ARCH-014: scope BOTH the fetch and the update by restaurant_id.
  // The sibling [id] PATCH/DELETE documents the invariant ("every
  // write on wine_lists is scoped both by id and by restaurant_id");
  // publish must honor it too so cross-tenant publish can't happen
  // even if RLS is relaxed in a future migration.
  const { data: list, error: fetchError } = await supabase
    .from("wine_lists")
    .select("slug, restaurant_id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError || !list) {
    return NextResponse.json({ error: "Wine list not found." }, { status: 404 });
  }

  // Generate slug if needed
  let slug = list.slug;
  if (!slug) {
    // Get restaurant name for slug
    const { data: restaurant } = await supabase
      .from("restaurants")
      .select("name")
      .eq("id", list.restaurant_id)
      .single();

    const { data: generatedSlug } = await supabase.rpc("generate_slug", {
      input: restaurant?.name ?? "wine-list",
    });
    slug = generatedSlug;
  }

  const { error: updateError } = await supabase
    .from("wine_lists")
    .update({
      is_published: true,
      last_published_at: new Date().toISOString(),
      slug,
    })
    .eq("id", id)
    .eq("restaurant_id", restaurantId);

  if (updateError) {
    console.error("publish failed:", updateError);
    Sentry.captureException(updateError, {
      tags: { surface: "wine-list", phase: "publish" },
      extra: { restaurantId, list_id: id },
    });
    return NextResponse.json({ error: "Publish failed." }, { status: 500 });
  }

  return NextResponse.json({ slug });
}
