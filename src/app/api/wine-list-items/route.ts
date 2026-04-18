import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    section_id: string;
    wine_id: string;
    glass_price?: number | null;
    bottle_price?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.section_id || !body.wine_id) {
    return NextResponse.json(
      { error: "section_id and wine_id are required." },
      { status: 400 },
    );
  }

  // Get the max position in this section
  const { data: existing } = await supabase
    .from("wine_list_items")
    .select("position")
    .eq("section_id", body.section_id)
    .order("position", { ascending: false })
    .limit(1);

  const nextPosition = (existing?.[0]?.position ?? -1) + 1;

  const { data: item, error } = await supabase
    .from("wine_list_items")
    .insert({
      section_id: body.section_id,
      wine_id: body.wine_id,
      position: nextPosition,
      glass_price: body.glass_price ?? null,
      bottle_price: body.bottle_price ?? null,
    })
    .select("id")
    .single();

  if (error || !item) {
    console.error("wine_list_items insert failed:", error);
    return NextResponse.json({ error: "Failed to add wine." }, { status: 500 });
  }

  return NextResponse.json({ id: item.id });
}
