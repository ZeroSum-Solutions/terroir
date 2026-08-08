import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { removeTeamMembership } from "@/lib/api/team-member-removal";
import { parseParams } from "@/lib/api/validation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ membership_id: string }>;

const MembershipParamsSchema = z.object({
  membership_id: z.string().uuid("membership_id must be a valid UUID"),
});

/** Revokes one membership in the caller's active restaurant. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("team:member-manage");
    if (auth instanceof NextResponse) return auth;

    const parsedParams = await parseParams(params, MembershipParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const membershipId = parsedParams.data.membership_id.toLowerCase();

    return idempotentMutationResponse<Json>({
      request,
      supabase: auth.supabase,
      restaurantId: auth.restaurantId,
      operationId: "api:DELETE:/api/team/{param}",
      payload: { membershipId },
      releaseOnError: false,
      handler: () =>
        removeTeamMembership({
          supabase: auth.supabase,
          restaurantId: auth.restaurantId,
          membershipId,
        }),
    });
  });
}
