import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

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
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: { name?: string; template?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Only allow updating safe fields
  const allowed: { name?: string; template?: string } = {};
  if (typeof body.name === "string") allowed.name = body.name.trim();
  if (typeof body.template === "string") allowed.template = body.template;

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
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
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Wine list not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

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
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Wine list not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
