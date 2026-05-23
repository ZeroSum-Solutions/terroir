import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: { role?: string };
  try {
    body = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const newRole = body.role;
  if (!newRole || !["owner", "manager", "staff"].includes(newRole)) {
    return Errors.badRequest("Invalid role. Must be owner, manager, or staff.");
  }

  // Fetch the target membership
  const { data: target } = await supabase
    .from("memberships")
    .select("id, user_id, role, restaurant_id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (!target) {
    return Errors.notFound("Member");
  }

  // Last-owner protection: don't allow demoting if they're the only owner
  if (target.role === "owner" && newRole !== "owner") {
    const { count } = await supabase
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", target.restaurant_id)
      .eq("role", "owner");

    if ((count ?? 0) <= 1) {
      return Errors.badRequest("Cannot demote the last owner.");
    }
  }

  const { error } = await supabase
    .from("memberships")
    .update({ role: newRole as "owner" | "manager" | "staff" })
    .eq("id", id);

  if (error) {
    console.error("role-update-rpc failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "team", phase: "role-update-rpc" },
      extra: { member_id: id, new_role: newRole },
    });
    return Errors.internal("Failed to update role.");
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, user, restaurantId } = auth;

  // Fetch target
  const { data: target } = await supabase
    .from("memberships")
    .select("id, user_id, restaurant_id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (!target) {
    return Errors.notFound("Member");
  }

  // Cannot remove yourself
  if (target.user_id === user.id) {
    return Errors.badRequest("Cannot remove yourself.");
  }

  const { error } = await supabase.from("memberships").delete().eq("id", id);

  if (error) {
    console.error("member-delete-rpc failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "team", phase: "member-delete-rpc" },
      extra: { member_id: id },
    });
    return Errors.internal("Failed to remove member.");
  }

  return NextResponse.json({ success: true });
}
