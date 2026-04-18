import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function POST(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get current list
  const { data: list, error: fetchError } = await supabase
    .from("wine_lists")
    .select("slug, restaurant_id")
    .eq("id", id)
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
    .eq("id", id);

  if (updateError) {
    console.error("publish failed:", updateError);
    return NextResponse.json({ error: "Publish failed." }, { status: 500 });
  }

  return NextResponse.json({ slug });
}
