import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  TeamIdParamsSchema,
  UpdateMemberRoleBodySchema,
} from "@/lib/api/team-schemas";
import { parseJson, parseParams } from "@/lib/api/validation";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireOwner();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;
    const parsedParams = await parseParams(params, TeamIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;
    const parsedBody = await parseJson(request, UpdateMemberRoleBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { role: newRole } = parsedBody.data;

    const { data: target, error: fetchError } = await supabase
      .from("memberships")
      .select("id, user_id, role, restaurant_id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!target) return Errors.notFound("Member");

    if (target.role === "owner" && newRole !== "owner") {
      const { count, error: countError } = await supabase
        .from("memberships")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", target.restaurant_id)
        .eq("role", "owner");
      if (countError) throw countError;
      if ((count ?? 0) <= 1) {
        return Errors.badRequest("Cannot demote the last owner.");
      }
    }

    const { data: updated, error } = await supabase
      .from("memberships")
      .update({ role: newRole })
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) return Errors.notFound("Member");

    return NextResponse.json({ success: true });
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireOwner();
    if (auth instanceof NextResponse) return auth;
    const { supabase, user, restaurantId } = auth;
    const parsedParams = await parseParams(params, TeamIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: target, error: fetchError } = await supabase
      .from("memberships")
      .select("id, user_id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!target) return Errors.notFound("Member");
    if (target.user_id === user.id) {
      return Errors.badRequest("Cannot remove yourself.");
    }

    const { data: removed, error } = await supabase
      .from("memberships")
      .delete()
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!removed) return Errors.notFound("Member");

    return NextResponse.json({ success: true });
  });
}
