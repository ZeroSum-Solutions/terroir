import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/api/auth";

export const runtime = "nodejs";

const InviteSchema = z.object({
  role: z.enum(["manager", "staff"]).optional().default("staff"),
});

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, user, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = InviteSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const role = parsed.data.role;

  const { data: invitation, error } = await supabase
    .from("invitations")
    .insert({
      restaurant_id: restaurantId,
      role,
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
