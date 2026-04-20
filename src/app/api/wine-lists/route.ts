import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { DEFAULT_SECTIONS } from "@/lib/wine-list/types";

export const runtime = "nodejs";

const CreateListSchema = z.object({
  name: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = CreateListSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const { name } = parsed.data;

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
    // Clean up the list. BND-008: scope the cleanup by restaurant_id too —
    // if RLS is ever misconfigured on wine_lists this defense-in-depth filter
    // still prevents a cross-tenant delete.
    await supabase
      .from("wine_lists")
      .delete()
      .eq("id", list.id)
      .eq("restaurant_id", restaurantId);
    return NextResponse.json(
      { error: "Failed to create sections." },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: list.id });
}
