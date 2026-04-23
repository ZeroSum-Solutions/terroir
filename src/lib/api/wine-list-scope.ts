// ARCH-014: defense-in-depth helpers that verify a wine-list-item /
// section belongs to the caller's restaurant BEFORE a mutation runs.
// RLS already gates cross-tenant access; these helpers are the
// application-layer belt-and-suspenders so a future policy relaxation
// doesn't silently open up publish + item mutations to cross-tenant
// writes.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;

/**
 * Returns true iff the given wine_list_item id belongs to a wine list
 * owned by restaurantId. The join goes
 * wine_list_items -> wine_list_sections -> wine_lists.
 *
 * Returns false on any error (including the common "not found" path
 * from .single() when the item doesn't exist). Callers should treat
 * false as "reject the mutation" — distinguishing "not found" from
 * "owned by another tenant" would leak tenant existence.
 */
export async function isOwnWineListItem(
  supabase: Client,
  itemId: string,
  restaurantId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("wine_list_items")
    .select("wine_list_sections!inner(wine_lists!inner(restaurant_id))")
    .eq("id", itemId)
    .single();

  if (error || !data) return false;

  // PostgREST nests the join result; grab the restaurant_id out.
  type JoinShape = {
    wine_list_sections: {
      wine_lists: { restaurant_id: string };
    };
  };
  const resolved = data as unknown as JoinShape;
  return resolved.wine_list_sections.wine_lists.restaurant_id === restaurantId;
}

/**
 * Returns true iff the given wine_list_sections id belongs to a wine
 * list owned by restaurantId.
 */
export async function isOwnWineListSection(
  supabase: Client,
  sectionId: string,
  restaurantId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("wine_list_sections")
    .select("wine_lists!inner(restaurant_id)")
    .eq("id", sectionId)
    .single();

  if (error || !data) return false;

  type JoinShape = { wine_lists: { restaurant_id: string } };
  const resolved = data as unknown as JoinShape;
  return resolved.wine_lists.restaurant_id === restaurantId;
}

/**
 * Returns true iff EVERY wine_list_items id in the provided array
 * belongs to a wine list owned by restaurantId. Used by the reorder
 * route, where the caller supplies an array of ids and we need to
 * reject the batch if any id is cross-tenant.
 */
export async function areAllOwnWineListItems(
  supabase: Client,
  itemIds: string[],
  restaurantId: string,
): Promise<boolean> {
  if (itemIds.length === 0) return true;
  const { data, error } = await supabase
    .from("wine_list_items")
    .select("id, wine_list_sections!inner(wine_lists!inner(restaurant_id))")
    .in("id", itemIds);

  if (error || !data) return false;
  if (data.length !== itemIds.length) return false;

  type JoinShape = {
    id: string;
    wine_list_sections: {
      wine_lists: { restaurant_id: string };
    };
  };
  const rows = data as unknown as JoinShape[];
  return rows.every(
    (r) => r.wine_list_sections.wine_lists.restaurant_id === restaurantId,
  );
}
