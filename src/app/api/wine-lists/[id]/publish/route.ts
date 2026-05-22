import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateSlug(slug: string): string | null {
  const trimmed = slug.trim().toLowerCase();
  if (!trimmed) return "Slug must not be empty.";
  if (!SLUG_RE.test(trimmed)) return "Slug must contain only lowercase letters, numbers, and hyphens.";
  if (trimmed.length > 50) return "Slug must be 50 characters or fewer.";
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
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

  // Determine slug — in priority order:
  // 1. Custom slug from request body (optional)
  // 2. Existing slug on the list (set via PATCH)
  // 3. Auto-generated slug from restaurant name
  let slug: string | null = list.slug;

  // Parse request body for optional custom slug
  let customSlug: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.slug === "string") customSlug = body.slug;
  } catch {
    // No body or bad JSON — use existing slug or auto-generate
  }

  if (customSlug) {
    const error = validateSlug(customSlug);
    if (error) {
      return NextResponse.json({ error }, { status: 422 });
    }
    const trimmed = customSlug.trim().toLowerCase();
    // Check uniqueness within the same restaurant (BND-156: slugs are
    // scoped per-restaurant; two restaurants can each have "dinner").
    const { data: existing } = await supabase
      .from("wine_lists")
      .select("id")
      .eq("slug", trimmed)
      .eq("restaurant_id", restaurantId)
      .neq("id", id)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: "This slug is already in use by another list in your restaurant.", code: "slug_collision" },
        { status: 409 },
      );
    }
    slug = trimmed;
  }

  // If still no slug, auto-generate
  if (!slug) {
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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // Verify the list exists and belongs to this restaurant
  const { data: list, error: fetchError } = await supabase
    .from("wine_lists")
    .select("id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError || !list) {
    return NextResponse.json({ error: "Wine list not found." }, { status: 404 });
  }

  const { error: updateError } = await supabase
    .from("wine_lists")
    .update({
      is_published: false,
      slug: null,
    })
    .eq("id", id)
    .eq("restaurant_id", restaurantId);

  if (updateError) {
    console.error("unpublish failed:", updateError);
    Sentry.captureException(updateError, {
      tags: { surface: "wine-list", phase: "unpublish" },
      extra: { restaurantId, list_id: id },
    });
    return NextResponse.json({ error: "Unpublish failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
