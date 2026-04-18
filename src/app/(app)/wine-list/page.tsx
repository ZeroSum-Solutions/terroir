import { createClient } from "@/lib/supabase/server";
import { WineListLanding } from "./wine-list-landing";

export default async function WineListPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) return null;

  const { data: lists } = await supabase
    .from("wine_lists")
    .select(
      "*, wine_list_sections(wine_list_items(id))",
    )
    .eq("restaurant_id", membership.restaurant_id)
    .order("updated_at", { ascending: false });

  // Compute wine counts from the nested join
  const listsWithCounts = (lists ?? []).map((list) => {
    const sections = (list.wine_list_sections ?? []) as Array<{
      wine_list_items: Array<{ id: string }>;
    }>;
    const wine_count = sections.reduce(
      (sum, s) => sum + (s.wine_list_items?.length ?? 0),
      0,
    );
    // Strip the nested join data — client doesn't need it
    const { wine_list_sections: _, ...rest } = list;
    return { ...rest, wine_count };
  });

  return (
    <WineListLanding
      lists={listsWithCounts}
      restaurantId={membership.restaurant_id}
    />
  );
}
