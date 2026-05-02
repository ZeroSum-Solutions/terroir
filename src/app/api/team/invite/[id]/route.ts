import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/api/auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * Revoke a pending invitation. Owner-only. Scoped to the active
 * restaurant so an owner of restaurant A can't delete an invitation
 * belonging to restaurant B even if they guessed the id.
 *
 * Returns 404 if the invitation doesn't exist (or belongs to another
 * restaurant), 400 if it has already been accepted (revoking an
 * accepted invite is a no-op — the membership it created lives on the
 * memberships table and must be removed via /api/team/members).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { data: target } = await supabase
    .from("invitations")
    .select("id, accepted_at")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (!target) {
    return NextResponse.json(
      { error: "Invitation not found." },
      { status: 404 },
    );
  }

  if (target.accepted_at) {
    return NextResponse.json(
      { error: "Invitation already accepted. Remove the member instead." },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("invitations")
    .delete()
    .eq("id", id)
    .eq("restaurant_id", restaurantId);

  if (error) {
    console.error("invitation-delete failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "team-invite", phase: "delete" },
      extra: { invitation_id: id, restaurantId },
    });
    return NextResponse.json(
      { error: "Failed to revoke invitation." },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
