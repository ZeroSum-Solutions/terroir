import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { WineListLanding } from "./wine-list-landing";

export const metadata: Metadata = { title: "Wine lists" };

export default async function WineListPage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId } = auth;

  const { data: lists } = await supabase
    .from("wine_lists")
    .select(
      "*, wine_list_sections(wine_list_items(id))",
    )
    .eq("restaurant_id", restaurantId)
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
    <WineListLanding lists={listsWithCounts} />
  );
}
