import { cache } from "react";
import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveMembership } from "@/lib/api/resolve-active-membership";

/**
 * Request-scoped cached auth context. React cache() deduplicates within a
 * single server render tree, so layout + page share one set of DB calls
 * instead of each querying independently.
 *
 * ARCH-013: routes active-membership resolution through the shared
 * resolveActiveMembership() helper — same cookie-first / created_at-DESC
 * logic requireMembership() uses for API routes. Previously this helper
 * did a raw .limit(1).single() with no ORDER BY, so a multi-membership
 * user could see one restaurant in the shell and another in API calls.
 */
export const getAuthContext = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error && !isAuthSessionMissingError(error)) throw error;
  if (!user) return null;

  const membership = await resolveActiveMembership(supabase, user.id);
  if (!membership) return null;

  return {
    user,
    supabase,
    restaurantId: membership.restaurantId,
    restaurantName: membership.restaurantName,
    userRole: membership.role,
    availableRestaurants: membership.availableRestaurants,
  };
});
