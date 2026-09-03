/**
 * Turn user ids into display names, for members of one restaurant only.
 *
 * Names live in `auth.users`, which a tenant cannot read, so resolving one
 * needs the service role — and service-role usage bypasses RLS entirely
 * (AGENTS.md non-negotiable #3). The gate is therefore applied here, in front
 * of it, and in the shape that file prescribes: the roster is read under the
 * CALLER's rights and scoped to the caller's own `restaurantId`, and only ids
 * that survive that read are ever passed to the admin client.
 *
 * This exists as one function rather than two call sites on purpose. The house
 * tasting log and the drink-window override both need exactly this lookup, and
 * a second hand-rolled copy of a membership gate in front of a service-role
 * client is precisely the "review-worthy event" the contract warns about. One
 * gate is one thing to audit.
 *
 * An id that is not on the roster resolves to nothing rather than reaching
 * outside it — a colleague who has left is not named by this function.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { resolveMemberIdentities } from "@/lib/team/member-identities";

export async function resolveRestaurantMemberNames(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = new Set(userIds.filter((id): id is string => Boolean(id)));
  if (wanted.size === 0) return new Map();

  const { data: roster } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("restaurant_id", restaurantId);

  const members = (roster ?? []).map((m) => m.user_id).filter((id) => wanted.has(id));
  if (members.length === 0) return new Map();

  // No service-role key configured is a degraded environment, not a failure:
  // the caller renders an unattributed value rather than throwing away the
  // value itself.
  const admin = createServiceRoleClient();
  if (!admin) return new Map();

  const identities = await resolveMemberIdentities(admin, members);
  return new Map(
    [...identities].flatMap(([id, identity]) => (identity.name ? [[id, identity.name] as const] : [])),
  );
}
