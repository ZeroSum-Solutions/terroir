import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { TeamIdParamsSchema } from "@/lib/api/team-schemas";
import { parseParams } from "@/lib/api/validation";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

type ResendInviteBody =
  | {
      id: string;
      token: string;
      role: "owner" | "manager" | "staff";
      email: string;
      expires_at: string;
      created_at: string;
      inviteUrl: string;
    }
  | { error: { code: string; message: string } };

/**
 * POST /api/team/invite/[id]/resend — resend a pending invitation.
 * Creates a new invitation row with the same email and role as the
 * original. The old invitation row remains valid and must be explicitly
 * revoked via DELETE /api/team/invite/[id] if no longer needed.
 *
 * Owner/manager-only. Returns 404 if the invitation doesn't exist (or
 * belongs to another restaurant), 400 if it has already been accepted.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("team:invite-manage", {
      rateLimit: "sensitive",
    });
    if (auth instanceof NextResponse) return auth;
    const { supabase, user, restaurantId } = auth;
    const parsedParams = await parseParams(params, TeamIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    return idempotentMutationResponse<ResendInviteBody>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/team/invite/{param}/resend",
      payload: { id },
      releaseOnError: false,
      handler: async () => {
        const { data: original, error: fetchError } = await supabase
          .from("invitations")
          .select("id, email, role, accepted_at")
          .eq("id", id)
          .eq("restaurant_id", restaurantId)
          .maybeSingle();
        if (fetchError) throw fetchError;
        if (!original) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found",
                message: "Invitation not found.",
              },
            },
          };
        }
        if (original.accepted_at) {
          return {
            status: 400,
            body: {
              error: {
                code: "bad_request",
                message: "Invitation already accepted. No need to resend.",
              },
            },
          };
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
        return {
          status: 200,
          body: { ...invitation, inviteUrl },
        };
      },
    });
  });
}
