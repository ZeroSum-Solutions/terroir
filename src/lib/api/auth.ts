import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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

/** Returns auth + restaurant membership, or a 401/403 response. */
export async function requireMembership(): Promise<
  MembershipResult | NextResponse
> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const { supabase, user } = auth;
  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) {
    return NextResponse.json(
      { error: "No restaurant membership found." },
      { status: 403 },
    );
  }

  return {
    supabase,
    user,
    restaurantId: membership.restaurant_id,
    role: membership.role as MembershipRole,
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
