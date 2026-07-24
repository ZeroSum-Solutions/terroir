import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { CreateInviteBodySchema } from "@/lib/api/team-schemas";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireCapability("team:invite-manage");
    if (auth instanceof NextResponse) return auth;
    const { supabase, user, restaurantId } = auth;

    const parsed = await parseJson(request, CreateInviteBodySchema);
    if (!parsed.ok) return parsed.response;
    const { email, role } = parsed.data;

    const { data: invitation, error } = await supabase
      .from("invitations")
      .insert({
        restaurant_id: restaurantId,
        email,
        role,
        invited_by: user.id,
      })
      .select("id, token, role, email, expires_at, created_at")
      .single();
    if (error || !invitation) {
      throw error ?? new Error("invitation insert returned no row");
    }

    const inviteUrl = `${request.nextUrl.origin}/invite/${invitation.token}`;
    return NextResponse.json({ ...invitation, inviteUrl });
  });
}
