import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { isOwnWineListSection } from "@/lib/api/wine-list-scope";

export const runtime = "nodejs";

const AddItemSchema = z.object({
  section_id: z.string().uuid(),
  wine_id: z.string().uuid(),
  glass_price: z.number().nonnegative().nullable().optional(),
  bottle_price: z.number().nonnegative().nullable().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

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

  // ARCH-014: before inserting, confirm section_id belongs to the
  // caller's restaurant. Otherwise a user with another tenant's
  // section_id could attempt to insert into it and rely on RLS
  // alone to block.
  if (!(await isOwnWineListSection(supabase, body.section_id, restaurantId))) {
    return NextResponse.json(
      { error: "Section not found." },
      { status: 404 },
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
    Sentry.captureException(
      error ?? new Error("wine_list_items insert returned null"),
      {
        tags: { surface: "wine-list-items", phase: "insert" },
        extra: {
          restaurantId,
          section_id: body.section_id,
          wine_id: body.wine_id,
        },
      },
    );
    return NextResponse.json({ error: "Failed to add wine." }, { status: 500 });
  }

  return NextResponse.json({ id: item.id });
}
