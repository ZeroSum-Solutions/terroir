import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WineListEditor } from "./wine-list-editor";

type Params = Promise<{ id: string }>;

export default async function WineListEditorPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: list, error } = await supabase
    .from("wine_lists")
    .select(
      "*, wine_list_sections(*, wine_list_items(*, wines(*)))",
    )
    .eq("id", id)
    .single();

  if (error || !list) notFound();

  // Sort sections by position, items by position within each section
  const sections = ((list.wine_list_sections ?? []) as Array<{
    id: string;
    name: string;
    position: number;
    wine_list_id: string;
    created_at: string;
    wine_list_items: Array<{
      id: string;
      section_id: string;
      wine_id: string;
      position: number;
      glass_price: number | null;
      bottle_price: number | null;
      tasting_note: string | null;
      is_available: boolean;
      created_at: string;
      updated_at: string;
      wines: {
        id: string;
        name: string;
        producer: string;
        vintage: number | null;
        varietal: string | null;
        region: string | null;
        restaurant_id: string;
        size_ml: number;
        country: string | null;
        lwin_id: string | null;
        created_at: string;
        updated_at: string;
      };
    }>;
  }>)
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      ...s,
      wine_list_items: [...(s.wine_list_items ?? [])].sort(
        (a, b) => a.position - b.position,
      ),
    }));

  const { wine_list_sections: _, ...listMeta } = list;

  return <WineListEditor list={listMeta} sections={sections} />;
}
