import type { Metadata } from "next";
import { NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";
import { requireMembership } from "@/lib/api/auth";
import { WineListEditor } from "./wine-list-editor";

export const metadata: Metadata = { title: "Edit list" };

type Params = Promise<{ id: string }>;

// ARCH-015: this server component is the primary read path for the
// wine-list editor. Before the fix it created its own supabase client
// and queried wine_lists by id only — RLS was the single enforcement
// point. Now we go through requireMembership (same pattern as
// /availability) and also filter by restaurant_id for defense-in-depth.
// A list UUID from another tenant 404s here even if RLS is ever relaxed.
export default async function WineListEditorPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;

  const auth = await requireMembership();
  if (auth instanceof NextResponse) {
    // requireMembership returned a NextResponse (401/403). Send to login.
    redirect(`/login?next=/wine-list/${id}`);
  }
  const { supabase, restaurantId } = auth;

  const { data: list, error } = await supabase
    .from("wine_lists")
    .select(
      "*, wine_list_sections(*, wine_list_items(*, wines(*)))",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
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
      glass_pour_ml: number | null;
      pour_size_mode: "fixed" | "picker";
      tasting_note: string | null;
      // is_available — deprecated by BND-037's wines.is_eightysixed.
      // Column still lives in the DB for read compat but isn't
      // writable via PATCH (ARCH-017). Drop from this type once the
      // read sites are migrated too.
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
        drink_window_start: number | null;
        drink_window_end: number | null;
        serving_temp_min: number | null;
        serving_temp_max: number | null;
        serving_temp_label: string | null;
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
