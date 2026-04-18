import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership || membership.role !== "owner") {
    return NextResponse.json(
      { error: "Only owners can invite team members." },
      { status: 403 },
    );
  }

  let body: { role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const role = body.role === "manager" ? "manager" : "staff";

  const { data: invitation, error } = await supabase
    .from("invitations")
    .insert({
      restaurant_id: membership.restaurant_id,
      role: role as "manager" | "staff",
      invited_by: user.id,
    })
    .select("id, token, role, expires_at, created_at")
    .single();

  if (error || !invitation) {
    console.error("invitation insert failed:", error);
    return NextResponse.json(
      { error: "Failed to create invitation." },
      { status: 500 },
    );
  }

  // Build the invite URL
  const origin = request.headers.get("origin") ?? request.nextUrl.origin;
  const inviteUrl = `${origin}/invite/${invitation.token}`;

  return NextResponse.json({ ...invitation, inviteUrl });
}
