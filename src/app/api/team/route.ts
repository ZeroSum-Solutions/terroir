import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { createTeamInvitation } from "@/lib/api/team-invitation";
import { CreateInviteBodySchema } from "@/lib/api/team-schemas";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

/** Returns active-tenant memberships and pending invitations without invite tokens. */
export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireCapability("team:view");
    if (auth instanceof NextResponse) return auth;

    const [membersResult, invitationsResult] = await Promise.all([
      auth.supabase
        .from("memberships")
        .select("id, user_id, role, created_at")
        .eq("restaurant_id", auth.restaurantId)
        .order("created_at"),
      auth.supabase
        .from("invitations")
        .select("id, role, email, expires_at, accepted_at, created_at")
        .eq("restaurant_id", auth.restaurantId)
        .is("accepted_at", null)
        .order("created_at", { ascending: false }),
    ]);
    if (membersResult.error) throw membersResult.error;
    if (invitationsResult.error) throw invitationsResult.error;

    return NextResponse.json({
      members: membersResult.data ?? [],
      invitations: (invitationsResult.data ?? []).map((invitation) => ({
        ...invitation,
        has_pending_invite: true,
      })),
      currentUserId: auth.user.id,
    });
  });
}

/** Creates an invitation for the caller's active restaurant. */
export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireCapability("team:invite-manage", {
      rateLimit: "sensitive",
    });
    if (auth instanceof NextResponse) return auth;

    const parsed = await parseJson(request, CreateInviteBodySchema);
    if (!parsed.ok) return parsed.response;
    const { email, role } = parsed.data;

    return idempotentMutationResponse({
      request,
      supabase: auth.supabase,
      restaurantId: auth.restaurantId,
      operationId: "api:POST:/api/team",
      payload: { email, role },
      releaseOnError: false,
      handler: () =>
        createTeamInvitation({
          supabase: auth.supabase,
          restaurantId: auth.restaurantId,
          userId: auth.user.id,
          email,
          role,
          origin: request.nextUrl.origin,
        }),
    });
  });
}
