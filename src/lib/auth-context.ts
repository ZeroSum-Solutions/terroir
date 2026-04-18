import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Request-scoped cached auth context. React cache() deduplicates within a
 * single server render tree, so layout + page share one set of DB calls
 * instead of each querying independently.
 */
export const getAuthContext = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id, role, restaurants(name)")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) return null;

  const restaurantId = membership.restaurant_id;
  const restaurantName =
    (membership.restaurants as { name: string } | null)?.name ?? "My Restaurant";
  const userRole = (membership.role ?? "staff") as "owner" | "manager" | "staff";

  return { user, supabase, restaurantId, restaurantName, userRole };
});
