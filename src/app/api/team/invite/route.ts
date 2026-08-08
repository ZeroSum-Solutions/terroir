import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { CreateInviteBodySchema } from "@/lib/api/team-schemas";
import { createTeamInvitation } from "@/lib/api/team-invitation";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireCapability("team:invite-manage", {
      rateLimit: "sensitive",
    });
    if (auth instanceof NextResponse) return auth;
    const { supabase, user, restaurantId } = auth;

    const parsed = await parseJson(request, CreateInviteBodySchema);
    if (!parsed.ok) return parsed.response;
    const { email, role } = parsed.data;

    return idempotentMutationResponse({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/team/invite",
      payload: { email, role },
      releaseOnError: false,
      handler: () =>
        createTeamInvitation({
          supabase,
          restaurantId,
          userId: user.id,
          email,
          role,
          origin: request.nextUrl.origin,
        }),
    });
  });
}
