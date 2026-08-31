import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { WineListLanding } from "../wine-list-landing";

export const metadata: Metadata = { title: "Wine lists" };

type SearchParams = Promise<{ show_archived?: string }>;

export default async function WineListPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { show_archived } = await searchParams;
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId, userRole } = auth;
  // SD-12: creating, cloning, archiving and deleting a list are all
  // requireRole(["owner","manager"]); reading them is membership-only.
  const canManage = userRole === "owner" || userRole === "manager";

  const { data: lists, error: listsError } = await supabase
    .from("wine_lists")
    .select(
      "*, wine_list_sections(wine_list_items(id))",
    )
    .eq("restaurant_id", restaurantId)
    .order("updated_at", { ascending: false });

  if (listsError) throw listsError;

  // Compute wine counts from the nested join, split by archived state
  const allLists = (lists ?? []).map((list) => {
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

  const activeLists = allLists.filter((l) => !l.archived);
  const archivedLists = allLists.filter((l) => l.archived);

  const visibleLists =
    show_archived === "1"
      ? activeLists // when showing archived, show active + archived separately
      : activeLists;

  return (
    <WineListLanding
      lists={visibleLists}
      archivedLists={archivedLists}
      showArchived={show_archived === "1"}
      canManage={canManage}
    />
  );
}
