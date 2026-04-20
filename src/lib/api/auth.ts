import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readActiveRestaurantFromCookie } from "@/lib/api/active-restaurant";
import type { Database } from "@/types/database";
import type { SupabaseClient } from "@supabase/supabase-js";

type MembershipRole = "owner" | "manager" | "staff";

export type AuthResult = {
  supabase: SupabaseClient<Database>;
  user: { id: string; email?: string };
};

export type MembershipResult = AuthResult & {
  restaurantId: string;
  role: MembershipRole;
};

/** Returns authenticated user + supabase client, or a 401 response. */
export async function requireAuth(): Promise<AuthResult | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return { supabase, user };
}

/**
 * Returns auth + restaurant membership, or a 401/403 response.
 *
 * For users with multiple memberships, the active restaurant is chosen by:
 *   1. a signed `active_restaurant_id` cookie if present AND the user still
 *      belongs to that restaurant, OR
 *   2. the most recently created membership (deterministic tiebreaker: id DESC).
 *
 * The order is stable across requests, which matters for every downstream
 * route that scopes queries by restaurant_id.
 */
export async function requireMembership(): Promise<
  MembershipResult | NextResponse
> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const { supabase, user } = auth;
  const { data: memberships } = await supabase
    .from("memberships")
    .select("restaurant_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (!memberships || memberships.length === 0) {
    return NextResponse.json(
      { error: "No restaurant membership found." },
      { status: 403 },
    );
  }

  const memberIds = memberships.map((m) => m.restaurant_id);
  const activeId = await readActiveRestaurantFromCookie(memberIds);
  const chosen =
    (activeId && memberships.find((m) => m.restaurant_id === activeId)) ||
    memberships[0];

  return {
    supabase,
    user,
    restaurantId: chosen.restaurant_id,
    role: chosen.role as MembershipRole,
  };
}

/** Returns membership with owner role, or 401/403 response. */
export async function requireOwner(): Promise<MembershipResult | NextResponse> {
  const result = await requireMembership();
  if (result instanceof NextResponse) return result;

  if (result.role !== "owner") {
    return NextResponse.json(
      { error: "Owner access required." },
      { status: 403 },
    );
  }

  return result;
}
