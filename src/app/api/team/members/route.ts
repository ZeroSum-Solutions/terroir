import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, user } = auth;

  // Fetch members — we can't directly join auth.users from the client,
  // so we fetch memberships and the user_id. The email comes from the
  // authenticated user's session or we store it separately.
  // For now, return user_id + role + created_at.
  const { data: members, error: membersError } = await supabase
    .from("memberships")
    .select("id, user_id, role, created_at")
    .eq("restaurant_id", restaurantId)
    .order("created_at");

  if (membersError) {
    return NextResponse.json(
      { error: "Failed to fetch members." },
      { status: 500 },
    );
  }

  // Fetch pending invitations.
  // BND-013: the `token` column used to be returned verbatim, which meant any
  // team member with read access to this endpoint could see every pending
  // invite token. Token is intentionally dropped from the select list here;
  // the owner-only `/api/team/invite` endpoint is the only way to obtain a
  // token (it's also the endpoint used to re-send invites, since each POST
  // creates a fresh row with a fresh token).
  const { data: rawInvitations, error: invitationsError } = await supabase
    .from("invitations")
    .select("id, role, email, expires_at, accepted_at, created_at")
    .eq("restaurant_id", restaurantId)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });

  if (invitationsError) {
    return NextResponse.json(
      { error: "Failed to fetch invitations." },
      { status: 500 },
    );
  }

  const invitations = (rawInvitations ?? []).map((inv) => ({
    ...inv,
    has_pending_invite: true,
  }));

  return NextResponse.json({
    members: members ?? [],
    invitations,
    currentUserId: user.id,
  });
}
