// ARCH-013: single source of truth for "which restaurant is active
// for this user on this request". Previously getAuthContext (used by
// AppLayout to drive the nav + RestaurantProvider) used
// .limit(1).single() with no ordering, and requireMembership (used by
// every API route) used a cookie-first / created_at-DESC fallback.
// For a user with two memberships the two helpers could disagree,
// leaving the shell showing one restaurant while API calls targeted
// another. Both now route through resolveActiveMembership so they
// always pick the same one.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { readActiveRestaurantFromCookie } from "@/lib/api/active-restaurant";

export type MembershipRole = "owner" | "manager" | "staff";

export type ResolvedMembership = {
  restaurantId: string;
  restaurantName: string;
  role: MembershipRole;
};

type Client = SupabaseClient<Database>;

/**
 * Returns the active membership for `userId`, or `null` if the user
 * has no memberships. Resolution order:
 *   1. signed `active_restaurant_id` cookie (if the user still
 *      belongs to that restaurant),
 *   2. most recently created membership (deterministic tiebreaker:
 *      id DESC).
 *
 * Always fetches the restaurant name in the same query so server-
 * component callers (AppLayout) don't need a second round trip.
 */
export async function resolveActiveMembership(
  supabase: Client,
  userId: string,
): Promise<ResolvedMembership | null> {
  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("restaurant_id, role, restaurants(name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (error || !memberships || memberships.length === 0) return null;

  const memberIds = memberships.map((m) => m.restaurant_id);
  const activeId = await readActiveRestaurantFromCookie(memberIds);

  const chosen =
    (activeId && memberships.find((m) => m.restaurant_id === activeId)) ||
    memberships[0];

  // Restaurants embed is nullable (a deleted restaurant would leave
  // an orphan membership row). Fall back to a placeholder.
  const restaurantName =
    (chosen.restaurants as { name: string } | null)?.name ?? "My Restaurant";

  return {
    restaurantId: chosen.restaurant_id,
    restaurantName,
    role: (chosen.role ?? "staff") as MembershipRole,
  };
}
