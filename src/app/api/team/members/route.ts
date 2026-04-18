import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) {
    return NextResponse.json(
      { error: "No restaurant membership found." },
      { status: 403 },
    );
  }

  const rid = membership.restaurant_id;

  // Fetch members — we can't directly join auth.users from the client,
  // so we fetch memberships and the user_id. The email comes from the
  // authenticated user's session or we store it separately.
  // For now, return user_id + role + created_at.
  const { data: members, error: membersError } = await supabase
    .from("memberships")
    .select("id, user_id, role, created_at")
    .eq("restaurant_id", rid)
    .order("created_at");

  if (membersError) {
    return NextResponse.json(
      { error: "Failed to fetch members." },
      { status: 500 },
    );
  }

  // Fetch pending invitations
  const { data: invitations, error: invitationsError } = await supabase
    .from("invitations")
    .select("id, token, role, email, expires_at, accepted_at, created_at")
    .eq("restaurant_id", rid)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });

  if (invitationsError) {
    return NextResponse.json(
      { error: "Failed to fetch invitations." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    members: members ?? [],
    invitations: invitations ?? [],
    currentUserId: user.id,
  });
}
