import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * BND-008: every write on `wine_lists` is scoped both by `id` and by
 * `restaurant_id`. RLS policies on the table already enforce this, but
 * application-level scoping is defense-in-depth — if RLS is ever
 * misconfigured (e.g. a migration drops or relaxes a policy), cross-tenant
 * writes still return 404 instead of silently mutating the other tenant's
 * row. We rely on `.select("id")` after the update/delete to distinguish
 * "row didn't exist" from "row exists but belongs to another restaurant":
 * both collapse to an empty result set and we surface a 404 in either case.
 * (ARCH-009)
 */

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: {
    name?: string;
    template?: string;
    slug?: string;
    archived?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  // Only allow updating safe fields (name, template, slug, archived)
  const allowed: {
    name?: string;
    template?: string;
    slug?: string;
    archived?: boolean;
  } = {};
  if (typeof body.name === "string") allowed.name = body.name.trim();
  if (typeof body.template === "string") allowed.template = body.template;
  if (typeof body.archived === "boolean") allowed.archived = body.archived;
  if (typeof body.slug === "string") {
    const trimmed = body.slug.trim().toLowerCase();
    if (!trimmed) {
      return Errors.unprocessable("invalid_slug", "Slug must not be empty.");
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed)) {
      return Errors.unprocessable(
          "invalid_slug",
          "Slug must contain only lowercase letters, numbers, and hyphens.",
        );
    }
    if (trimmed.length > 50) {
      return Errors.unprocessable("invalid_slug", "Slug must be 50 characters or fewer.");
    }
    // Check slug uniqueness within the same restaurant (BND-156: slugs are
    // scoped per-restaurant; two restaurants can each have "dinner").
    const { data: existing } = await supabase
      .from("wine_lists")
      .select("id")
      .eq("slug", trimmed)
      .eq("restaurant_id", restaurantId)
      .neq("id", id)
      .maybeSingle();
    if (existing) {
      return Errors.conflict(
          "slug_collision",
          "This slug is already in use by another list in your restaurant.",
        );
    }
    allowed.slug = trimmed;
  }

  if (Object.keys(allowed).length === 0) {
    return Errors.badRequest("No valid fields to update.");
  }

  const { data, error } = await supabase
    .from("wine_lists")
    .update(allowed)
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .select("id");

  if (error) {
    console.error("wine_lists update failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-list", phase: "update" },
      extra: { restaurantId, list_id: id },
    });
    return Errors.internal("Update failed.");
  }

  if (!data || data.length === 0) {
    return Errors.notFound("Wine list");
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // BND-159: only archived lists can be permanently deleted. Active lists
  // must be archived first. Fetch the current state before deleting.
  const { data: list, error: fetchError } = await supabase
    .from("wine_lists")
    .select("archived")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchError) {
    // PGRST116 = "No rows returned" — surface as 404. Any other error is
    // a server-side failure (e.g. connection drop, constraint violation).
    if ((fetchError as { code?: string }).code === "PGRST116") {
      return Errors.notFound("Wine list");
    }
    console.error("wine_lists pre-delete fetch failed:", fetchError);
    Sentry.captureException(fetchError, {
      tags: { surface: "wine-list", phase: "delete-fetch" },
      extra: { restaurantId, list_id: id },
    });
    return Errors.internal("Delete failed.");
  }
  if (!list) {
    return Errors.notFound("Wine list");
  }

  if (!list.archived) {
    return Errors.conflict(
        "must_archive_first",
        "Active lists must be archived before they can be deleted.",
      );
  }

  // Cascade delete: fetch section IDs, delete items, then sections, then the list.
  const { data: sections, error: sectionsFetchError } = await supabase
    .from("wine_list_sections")
    .select("id")
    .eq("wine_list_id", id);

  if (sectionsFetchError) {
    console.error("wine_list_sections fetch failed:", sectionsFetchError);
    Sentry.captureException(sectionsFetchError, {
      tags: { surface: "wine-list", phase: "delete-sections-fetch" },
      extra: { restaurantId, list_id: id },
    });
    return Errors.internal("Delete failed.");
  }

  const sectionIds = sections.map((s) => s.id);

  if (sectionIds.length > 0) {
    const { error: itemsError } = await supabase
      .from("wine_list_items")
      .delete()
      .in("section_id", sectionIds);

    if (itemsError) {
      console.error("wine_list_items cascade delete failed:", itemsError);
      Sentry.captureException(itemsError, {
        tags: { surface: "wine-list", phase: "delete-items" },
        extra: { restaurantId, list_id: id },
      });
      return Errors.internal("Delete failed.");
    }
  }

  const { error: sectionsError } = await supabase
    .from("wine_list_sections")
    .delete()
    .eq("wine_list_id", id);

  if (sectionsError) {
    console.error("wine_list_sections cascade delete failed:", sectionsError);
    Sentry.captureException(sectionsError, {
      tags: { surface: "wine-list", phase: "delete-sections" },
      extra: { restaurantId, list_id: id },
    });
    return Errors.internal("Delete failed.");
  }

  const { data, error } = await supabase
    .from("wine_lists")
    .delete()
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .select("id");

  if (error) {
    console.error("wine_lists delete failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-list", phase: "delete" },
      extra: { restaurantId, list_id: id },
    });
    return Errors.internal("Delete failed.");
  }

  if (!data || data.length === 0) {
    return Errors.notFound("Wine list");
  }

  return NextResponse.json({ ok: true });
}
