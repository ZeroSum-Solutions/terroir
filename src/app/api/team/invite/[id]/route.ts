import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { TeamIdParamsSchema } from "@/lib/api/team-schemas";
import { parseParams } from "@/lib/api/validation";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

type RevokeInviteBody =
  | { success: true }
  | { error: { code: string; message: string } };

/**
 * Revoke a pending invitation. Owner/manager-only. Scoped to the active
 * restaurant so an owner of restaurant A can't delete an invitation
 * belonging to restaurant B even if they guessed the id.
 *
 * Returns 404 if the invitation doesn't exist (or belongs to another
 * restaurant), 400 if it has already been accepted (revoking an
 * accepted invite is a no-op — the membership it created lives on the
 * memberships table and must be removed via /api/team/members).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("team:invite-manage");
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;
    const parsedParams = await parseParams(params, TeamIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    return idempotentMutationResponse<RevokeInviteBody>({
      request,
      supabase,
      restaurantId,
      operationId: "api:DELETE:/api/team/invite/{param}",
      payload: { id },
      releaseOnError: false,
      handler: async () => {
        const { data: target, error: fetchError } = await supabase
          .from("invitations")
          .select("id, accepted_at")
          .eq("id", id)
          .eq("restaurant_id", restaurantId)
          .maybeSingle();
        if (fetchError) throw fetchError;
        if (!target) {
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
        if (target.accepted_at) {
          return {
            status: 400,
            body: {
              error: {
                code: "bad_request",
                message:
                  "Invitation already accepted. Remove the member instead.",
              },
            },
          };
        }

        const { data: revoked, error } = await supabase
          .from("invitations")
          .delete()
          .eq("id", id)
          .eq("restaurant_id", restaurantId)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!revoked) {
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

        return { status: 200, body: { success: true as const } };
      },
    });
  });
}
