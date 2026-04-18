import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod/v4";
import { requireAuth } from "@/lib/api/auth";

export const runtime = "nodejs";

const AddItemSchema = z.object({
  section_id: z.string().uuid(),
  wine_id: z.string().uuid(),
  glass_price: z.number().nonnegative().nullable().optional(),
  bottle_price: z.number().nonnegative().nullable().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = AddItemSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const body = parsed.data;

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
