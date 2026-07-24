import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { TeamIdParamsSchema } from "@/lib/api/team-schemas";
import { parseParams } from "@/lib/api/validation";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * POST /api/team/invite/[id]/resend — resend a pending invitation.
 * Creates a new invitation row with the same email and role as the
 * original. The old invitation row remains valid and must be explicitly
 * revoked via DELETE /api/team/invite/[id] if no longer needed.
 *
 * Owner-only. Returns 404 if the invitation doesn't exist (or belongs to
 * another restaurant), 400 if it has already been accepted.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireOwner();
    if (auth instanceof NextResponse) return auth;
    const { supabase, user, restaurantId } = auth;
    const parsedParams = await parseParams(params, TeamIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: original, error: fetchError } = await supabase
      .from("invitations")
      .select("id, email, role, accepted_at")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!original) return Errors.notFound("Invitation");
    if (original.accepted_at) {
      return Errors.badRequest(
        "Invitation already accepted. No need to resend.",
      );
    }

    const { data: invitation, error } = await supabase
      .from("invitations")
      .insert({
        restaurant_id: restaurantId,
        email: original.email,
        role: original.role,
        invited_by: user.id,
      })
      .select("id, token, role, email, expires_at, created_at")
      .single();
    if (error || !invitation) {
      throw error ?? new Error("invitation resend returned no row");
    }

    const inviteUrl = `${request.nextUrl.origin}/invite/${invitation.token}`;
    return NextResponse.json({ ...invitation, inviteUrl });
  });
}
