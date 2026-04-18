import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_SECTIONS } from "@/lib/wine-list/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { name: string; restaurantId: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const { name, restaurantId } = body;
  if (!name || !restaurantId) {
    return NextResponse.json(
      { error: "name and restaurantId are required." },
      { status: 400 },
    );
  }

  // Create the wine list
  const { data: list, error: listError } = await supabase
    .from("wine_lists")
    .insert({ name: name.trim(), restaurant_id: restaurantId })
    .select("id")
    .single();

  if (listError || !list) {
    console.error("wine_lists insert failed:", listError);
    return NextResponse.json(
      { error: "Failed to create wine list." },
      { status: 500 },
    );
  }

  // Create default sections
  const sectionInserts = DEFAULT_SECTIONS.map((sectionName, idx) => ({
    wine_list_id: list.id,
    name: sectionName,
    position: idx,
  }));

  const { error: sectionsError } = await supabase
    .from("wine_list_sections")
    .insert(sectionInserts);

  if (sectionsError) {
    console.error("wine_list_sections insert failed:", sectionsError);
    // Clean up the list
    await supabase.from("wine_lists").delete().eq("id", list.id);
    return NextResponse.json(
      { error: "Failed to create sections." },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: list.id });
}
